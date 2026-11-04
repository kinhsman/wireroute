// Package relay lets a VPN server open connections to websites on a
// WireRoute user's behalf.
//
// Why: over a long line (US to Vietnam, ~260ms) every new connection to a
// site starts slow and has to warm up across the ocean, so pages with many
// pictures load slowly. With the relay, the server talks to the site from
// next door (fast), and all of a browser's traffic rides one long-lived,
// already-warm connection between the user and the server.
//
// The relay only listens on the server's VPN address, so it can't be reached
// from the internet and gives VPN users nothing they couldn't already reach.
//
// Wire format: one TCP connection carries a yamux session. Each stream starts
// with one line from the client and one line back:
//
//	HELLO\n              -> WIREROUTE-RELAY 1\n
//	DIAL host:port\n     -> OK\n   (then raw bytes both ways)
//	                     -> ERR <reason>\n
//
// The same file is copied into the custom wg-easy image (see
// tools/sync-relay.sh); keep it free of WireRoute-only code.
package relay

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/hashicorp/yamux"
)

const (
	Port       = 51829
	Version    = "1"
	banner     = "WIREROUTE-RELAY " + Version
	lineMax    = 600
	dialWait   = 10 * time.Second
	headerWait = 15 * time.Second
)

// muxConfig is shared by both ends. The stream window must cover a fast
// line's round trip (yamux's 256KB default caps a stream at ~1MB/s over
// 260ms); it grows toward the max only as data actually flows.
func muxConfig() *yamux.Config {
	c := yamux.DefaultConfig()
	c.AcceptBacklog = 1024
	c.EnableKeepAlive = true
	c.KeepAliveInterval = 15 * time.Second
	c.ConnectionWriteTimeout = 15 * time.Second
	c.MaxStreamWindowSize = 16 << 20
	c.StreamOpenTimeout = 15 * time.Second
	c.StreamCloseTimeout = 2 * time.Minute
	c.LogOutput = io.Discard
	return c
}

// readLine reads one '\n'-terminated line a byte at a time, so nothing after
// it is consumed (the rest of the stream is the site's data).
func readLine(r io.Reader) (string, error) {
	var b [1]byte
	var sb strings.Builder
	for sb.Len() < lineMax {
		if _, err := io.ReadFull(r, b[:]); err != nil {
			return "", err
		}
		if b[0] == '\n' {
			return sb.String(), nil
		}
		sb.WriteByte(b[0])
	}
	return "", errors.New("line too long")
}

// ---------------------------------------------------------------- server

// Server accepts relay sessions. Allowed decides which connections may use
// it (by the address they came from and the address they reached).
type Server struct {
	Allowed func(remote, local netip.Addr) bool
	Logf    func(format string, args ...any)
	Dialer  net.Dialer
	// DialFunc replaces Dialer when set (tests, or a relay inside a
	// userspace network). It gets "host:port" and does its own blocking.
	DialFunc func(ctx context.Context, address string) (net.Conn, error)
}

func (s *Server) logf(f string, a ...any) {
	if s.Logf != nil {
		s.Logf(f, a...)
	}
}

// Serve accepts connections until the listener fails.
func (s *Server) Serve(ln net.Listener) error {
	for {
		c, err := ln.Accept()
		if err != nil {
			return err
		}
		go s.handleConn(c)
	}
}

func addrOf(a net.Addr) netip.Addr {
	if ap, err := netip.ParseAddrPort(a.String()); err == nil {
		return ap.Addr().Unmap()
	}
	return netip.Addr{}
}

func (s *Server) handleConn(c net.Conn) {
	if s.Allowed != nil && !s.Allowed(addrOf(c.RemoteAddr()), addrOf(c.LocalAddr())) {
		c.Close()
		return
	}
	if tc, ok := c.(*net.TCPConn); ok {
		tc.SetNoDelay(true)
	}
	sess, err := yamux.Server(c, muxConfig())
	if err != nil {
		c.Close()
		return
	}
	defer sess.Close()
	for {
		st, err := sess.AcceptStream()
		if err != nil {
			return
		}
		go s.handleStream(st)
	}
}

func (s *Server) handleStream(st *yamux.Stream) {
	st.SetReadDeadline(time.Now().Add(headerWait))
	line, err := readLine(st)
	if err != nil {
		st.Close()
		return
	}
	st.SetReadDeadline(time.Time{})
	cmd, arg, _ := strings.Cut(line, " ")
	switch cmd {
	case "HELLO":
		io.WriteString(st, banner+"\n")
		st.Close()
	case "DIAL":
		s.dial(st, arg)
	default:
		io.WriteString(st, "ERR unknown command\n")
		st.Close()
	}
}

func (s *Server) dial(st *yamux.Stream, target string) {
	host, port, err := net.SplitHostPort(target)
	if err != nil || host == "" || port == "" {
		io.WriteString(st, "ERR bad address\n")
		st.Close()
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), dialWait)
	defer cancel()
	dial := s.DialFunc
	if dial == nil {
		dial = s.dialSafe
	}
	out, err := dial(ctx, net.JoinHostPort(host, port))
	if err != nil {
		reason := "can't connect"
		var dnsErr *net.DNSError
		switch {
		case errors.As(err, &dnsErr):
			reason = "no such site"
		case errors.Is(err, errNotAllowed):
			reason = "not allowed"
		}
		io.WriteString(st, "ERR "+reason+"\n")
		st.Close()
		return
	}
	if _, err := io.WriteString(st, "OK\n"); err != nil {
		out.Close()
		st.Close()
		return
	}
	pipe(st, out)
}

// dialSafe is the normal dial: Go's dialer (IPv4 and IPv6 tried side by
// side), to public internet addresses only.
func (s *Server) dialSafe(ctx context.Context, address string) (net.Conn, error) {
	d := s.Dialer
	d.ControlContext = func(_ context.Context, _, address string, _ syscall.RawConn) error {
		if ap, err := netip.ParseAddrPort(address); err == nil && !Public(ap.Addr()) {
			return errNotAllowed
		}
		return nil
	}
	return d.DialContext(ctx, "tcp", address)
}

var errNotAllowed = errors.New("not allowed")

// ErrNotAllowed is the text of the relay's answer for a private address.
const ErrNotAllowed = "not allowed"

var cgnat = netip.MustParsePrefix("100.64.0.0/10")

// Public reports whether ip is an ordinary internet address. The relay is
// for websites: it never reaches the server itself, its home network, VPN
// or Tailscale addresses, or link-local and multicast ones. (Those stay
// reachable straight through the tunnel, as before, where the tunnel allows.)
func Public(ip netip.Addr) bool {
	ip = ip.Unmap()
	return ip.IsValid() && !ip.IsLoopback() && !ip.IsUnspecified() && !ip.IsPrivate() &&
		!ip.IsLinkLocalUnicast() && !ip.IsLinkLocalMulticast() && !ip.IsMulticast() &&
		!ip.IsInterfaceLocalMulticast() && !cgnat.Contains(ip)
}

// pipe copies both ways, passing on a half-close, until both sides finish.
func pipe(a, b net.Conn) {
	var wg sync.WaitGroup
	wg.Add(2)
	cp := func(dst, src net.Conn) {
		defer wg.Done()
		io.Copy(dst, src)
		closeWrite(dst)
	}
	go cp(a, b)
	go cp(b, a)
	wg.Wait()
	a.Close()
	b.Close()
}

func closeWrite(c net.Conn) {
	switch v := c.(type) {
	case *net.TCPConn:
		v.CloseWrite()
	case *yamux.Stream:
		v.Close() // yamux: sends FIN, the stream stays readable
	case interface{ CloseWrite() error }:
		v.CloseWrite()
	default:
		c.Close()
	}
}

// ---------------------------------------------------------------- client

// ErrRelay means the relay itself failed (not the site): the caller should
// fall back to connecting without it.
var ErrRelay = errors.New("relay unavailable")

// Session is the user's side of one relay connection.
type Session struct {
	sess *yamux.Session
}

// Connect starts a session over an already-open connection to the relay and
// checks the far end really is a relay.
func Connect(ctx context.Context, c net.Conn) (*Session, error) {
	sess, err := yamux.Client(c, muxConfig())
	if err != nil {
		c.Close()
		return nil, fmt.Errorf("%w: %v", ErrRelay, err)
	}
	s := &Session{sess: sess}
	st, err := s.open(ctx)
	if err != nil {
		sess.Close()
		return nil, err
	}
	defer st.Close()
	if dl, ok := ctx.Deadline(); ok {
		st.SetDeadline(dl)
	}
	io.WriteString(st, "HELLO\n")
	line, err := readLine(st)
	if err != nil || !strings.HasPrefix(line, "WIREROUTE-RELAY ") {
		sess.Close()
		return nil, fmt.Errorf("%w: not a relay", ErrRelay)
	}
	return s, nil
}

func (s *Session) open(ctx context.Context) (*yamux.Stream, error) {
	type res struct {
		st  *yamux.Stream
		err error
	}
	ch := make(chan res, 1)
	go func() {
		st, err := s.sess.OpenStream()
		ch <- res{st, err}
	}()
	select {
	case r := <-ch:
		if r.err != nil {
			return nil, fmt.Errorf("%w: %v", ErrRelay, r.err)
		}
		return r.st, nil
	case <-ctx.Done():
		go func() {
			if r := <-ch; r.st != nil {
				r.st.Close()
			}
		}()
		return nil, ctx.Err()
	}
}

// Dial asks the relay to connect to host:port. An error wrapping ErrRelay
// means the relay is broken; any other error is about the site.
func (s *Session) Dial(ctx context.Context, address string) (net.Conn, error) {
	st, err := s.open(ctx)
	if err != nil {
		return nil, err
	}
	stop := context.AfterFunc(ctx, func() { st.SetDeadline(time.Now()) })
	defer stop()
	if _, err := io.WriteString(st, "DIAL "+address+"\n"); err != nil {
		st.Close()
		return nil, fmt.Errorf("%w: %v", ErrRelay, err)
	}
	line, err := readLine(st)
	if !stop() {
		st.Close()
		return nil, ctx.Err()
	}
	if err != nil {
		st.Close()
		if s.sess.IsClosed() {
			return nil, fmt.Errorf("%w: %v", ErrRelay, err)
		}
		return nil, fmt.Errorf("relay: %v", err)
	}
	if line != "OK" {
		st.Close()
		return nil, fmt.Errorf("%s", strings.TrimPrefix(line, "ERR "))
	}
	st.SetDeadline(time.Time{})
	return st, nil
}

// Closed reports whether the session has ended.
func (s *Session) Closed() bool { return s.sess.IsClosed() }

// Close ends the session and every connection on it.
func (s *Session) Close() error { return s.sess.Close() }
