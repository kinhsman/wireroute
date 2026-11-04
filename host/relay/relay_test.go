package relay

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"io"
	"net"
	"net/netip"
	"strings"
	"sync"
	"testing"
	"time"
)

// echoServer answers every connection by echoing it back, and closes its side
// once the other side has finished sending.
func echoServer(t *testing.T) string {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				io.Copy(c, c)
				c.Close()
			}()
		}
	}()
	return ln.Addr().String()
}

// startRelay runs a relay on loopback. Every DIAL goes to target unless
// target is "", in which case the normal (safe) dialer is used.
func startRelay(t *testing.T, target string, allowed func(remote, local netip.Addr) bool) (addr string, stop func()) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{Allowed: allowed}
	if target != "" {
		s.DialFunc = func(ctx context.Context, address string) (net.Conn, error) {
			if strings.HasPrefix(address, "nope.") {
				return nil, &net.DNSError{Err: "no such host", Name: address}
			}
			var d net.Dialer
			return d.DialContext(ctx, "tcp", target)
		}
	}
	go s.Serve(ln)
	var mu sync.Mutex
	stopped := false
	return ln.Addr().String(), func() {
		mu.Lock()
		defer mu.Unlock()
		if !stopped {
			stopped = true
			ln.Close()
		}
	}
}

func connect(t *testing.T, addr string) (*Session, error) {
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return Connect(ctx, c)
}

func dial(s *Session, target string) (net.Conn, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return s.Dial(ctx, target)
}

func TestRelayCarriesDataBothWaysAndPassesOnTheEnd(t *testing.T) {
	addr, stop := startRelay(t, echoServer(t), nil)
	defer stop()
	s, err := connect(t, addr)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	c, err := dial(s, "site.test:443")
	if err != nil {
		t.Fatal(err)
	}
	msg := make([]byte, 3<<20)
	rand.Read(msg)
	go func() {
		c.Write(msg)
		c.(interface{ Close() error }).Close() // yamux: we're done sending
	}()
	c.SetReadDeadline(time.Now().Add(10 * time.Second))
	got, err := io.ReadAll(c)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if !bytes.Equal(got, msg) {
		t.Fatalf("got %d bytes back, sent %d", len(got), len(msg))
	}
}

func TestManyConnectionsAtOnce(t *testing.T) {
	addr, stop := startRelay(t, echoServer(t), nil)
	defer stop()
	s, err := connect(t, addr)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var wg sync.WaitGroup
	errs := make(chan error, 200)
	for i := range 200 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c, err := dial(s, "site.test:443")
			if err != nil {
				errs <- err
				return
			}
			defer c.Close()
			want := strings.Repeat("x", 1000+i)
			c.SetDeadline(time.Now().Add(10 * time.Second))
			io.WriteString(c, want)
			buf := make([]byte, len(want))
			if _, err := io.ReadFull(c, buf); err != nil || string(buf) != want {
				errs <- errors.New("wrong echo")
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
}

func TestSiteErrorsAreNotRelayErrors(t *testing.T) {
	addr, stop := startRelay(t, echoServer(t), nil)
	defer stop()
	s, err := connect(t, addr)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	_, err = dial(s, "nope.test:443")
	if err == nil || errors.Is(err, ErrRelay) || !strings.Contains(err.Error(), "no such site") {
		t.Fatalf("got %v, want a site error", err)
	}
	if s.Closed() {
		t.Fatal("a missing site shouldn't end the session")
	}
}

func TestRelayOnlyReachesPublicAddresses(t *testing.T) {
	addr, stop := startRelay(t, "", nil)
	defer stop()
	s, err := connect(t, addr)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	for _, target := range []string{"192.168.7.15:53", "10.1.30.1:80", "172.17.0.1:80", "100.69.197.139:443", "169.254.169.254:80", "[fd00::1]:80", "[fe80::1]:80"} {
		_, err := dial(s, target)
		if err == nil || errors.Is(err, ErrRelay) || !strings.Contains(err.Error(), "not allowed") {
			t.Errorf("%s: got %v, want not allowed", target, err)
		}
	}
	for _, ip := range []string{"1.1.1.1", "8.8.8.8", "2606:4700::1111"} {
		if !Public(netip.MustParseAddr(ip)) {
			t.Errorf("%s should count as public", ip)
		}
	}
}

func TestRelayNeverConnectsToItsOwnMachine(t *testing.T) {
	addr, stop := startRelay(t, "", nil) // the real, safe dialer
	defer stop()
	s, err := connect(t, addr)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	for _, target := range []string{echoServer(t), "localhost:22", "[::1]:22", "0.0.0.0:22"} {
		_, err := dial(s, target)
		if err == nil || errors.Is(err, ErrRelay) || !strings.Contains(err.Error(), "not allowed") {
			t.Errorf("%s: got %v, want not allowed", target, err)
		}
	}
}

func TestSomethingElseOnThePortIsNotARelay(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			io.WriteString(c, "SSH-2.0-OpenSSH_9.6\r\n")
			time.Sleep(time.Second)
			c.Close()
		}
	}()
	if _, err := connect(t, ln.Addr().String()); !errors.Is(err, ErrRelay) {
		t.Fatalf("got %v, want ErrRelay", err)
	}
}

func TestRefusedUsersGetNothing(t *testing.T) {
	addr, stop := startRelay(t, echoServer(t), func(remote, local netip.Addr) bool { return false })
	defer stop()
	if _, err := connect(t, addr); !errors.Is(err, ErrRelay) {
		t.Fatalf("got %v, want ErrRelay", err)
	}
}

func TestRelayGoingAwayIsARelayError(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	var server net.Conn
	accepted := make(chan struct{})
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		server = c
		close(accepted)
		(&Server{DialFunc: func(ctx context.Context, a string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "tcp", echoServerAddr)
		}}).handleConn(c)
	}()
	echoServerAddr = echoServer(t)
	s, err := connect(t, ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	<-accepted
	server.Close() // the server restarts, the line drops
	time.Sleep(100 * time.Millisecond)
	if _, err := dial(s, "site.test:443"); !errors.Is(err, ErrRelay) {
		t.Fatalf("got %v, want ErrRelay", err)
	}
}

var echoServerAddr string
