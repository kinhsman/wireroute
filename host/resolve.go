package main

// Name lookups and connects through a tunnel.
//
// The netstack's own versions are slow in ways that show up in a browser:
// they ask DNS servers one at a time with 5s each, wait for the IPv6 answer
// even when IPv4 is enough, and try IPv6 addresses first. Many WireGuard
// servers (lambut included) hand out an IPv6 address but can't reach IPv6
// sites, so every new connection lost time on dead IPv6 tries, and sometimes
// stalled until timeout.

import (
	"context"
	"errors"
	"math/rand/v2"
	"net"
	"net/netip"
	"sync"
	"time"

	"golang.org/x/net/dns/dnsmessage"
)

const (
	dnsResend     = 1 * time.Second        // ask again if no answer yet
	dnsCacheMin   = 30 * time.Second       // keep answers at least this long
	dnsCacheMax   = 5 * time.Minute        // and at most this long
	v6Grace       = 50 * time.Millisecond  // wait this long for IPv6 once IPv4 answered
	fallbackDelay = 300 * time.Millisecond // start the next address if no connect yet
)

var errNoAddress = errors.New("no such site")

type dnsEntry struct {
	v4, v6 []netip.Addr
	until  time.Time
}

type dnsCache struct {
	mu sync.Mutex
	m  map[string]dnsEntry
}

func (c *dnsCache) get(host string) (dnsEntry, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.m[host]
	if !ok || time.Now().After(e.until) {
		return dnsEntry{}, false
	}
	return e, true
}

func (c *dnsCache) put(host string, e dnsEntry) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.m == nil {
		c.m = map[string]dnsEntry{}
	}
	if len(c.m) > 2000 {
		now := time.Now()
		for k, v := range c.m {
			if now.After(v.until) {
				delete(c.m, k)
			}
		}
	}
	c.m[host] = e
}

func (c *dnsCache) drop(host string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.m, host)
}

// dialTCP connects to "host:port" through the tunnel: IPv4 first, the next
// address started if one hasn't connected within fallbackDelay.
func (t *Tunnel) dialTCP(ctx context.Context, address string) (net.Conn, error) {
	host, sport, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	port, err := net.LookupPort("tcp", sport)
	if err != nil {
		return nil, err
	}
	var ips []netip.Addr
	cached := false
	if ip, err := netip.ParseAddr(host); err == nil {
		ips = []netip.Addr{ip.Unmap()}
	} else {
		var e dnsEntry
		e, cached = t.dns.get(host)
		if !cached {
			if e, err = t.lookup(ctx, host); err != nil {
				return nil, &net.OpError{Op: "dial", Net: "tcp", Err: &net.DNSError{Err: err.Error(), Name: host}}
			}
		}
		ips = append(append(ips, e.v4...), e.v6...)
	}
	addrs := make([]netip.AddrPort, 0, len(ips))
	for _, ip := range ips {
		if (ip.Is4() && t.hasV4) || (ip.Is6() && t.hasV6) {
			addrs = append(addrs, netip.AddrPortFrom(ip, uint16(port)))
		}
	}
	if len(addrs) == 0 {
		return nil, &net.OpError{Op: "dial", Net: "tcp", Err: errNoAddress}
	}
	c, err := t.race(ctx, addrs)
	if err != nil && cached {
		t.dns.drop(host) // maybe the site moved; look it up fresh next time
	}
	return c, err
}

// race starts the addresses in order, one more every fallbackDelay or as soon
// as one fails, and returns the first that connects.
func (t *Tunnel) race(ctx context.Context, addrs []netip.AddrPort) (net.Conn, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	type result struct {
		c   net.Conn
		err error
	}
	ch := make(chan result, len(addrs))
	next, pending := 0, 0
	start := func() {
		a := addrs[next]
		next++
		pending++
		go func() {
			c, err := t.tnet.DialContextTCPAddrPort(ctx, a)
			if err != nil {
				ch <- result{nil, err}
				return
			}
			ch <- result{c, nil}
		}()
	}
	start()
	timer := time.NewTimer(fallbackDelay)
	defer timer.Stop()
	var firstErr error
	for pending > 0 {
		select {
		case r := <-ch:
			pending--
			if r.err == nil {
				// Close any slower ones that still connect.
				go func(n int) {
					for range n {
						if r := <-ch; r.c != nil {
							r.c.Close()
						}
					}
				}(pending)
				return r.c, nil
			}
			if firstErr == nil {
				firstErr = r.err
			}
			if next < len(addrs) {
				start()
				timer.Reset(fallbackDelay)
			}
		case <-timer.C:
			if next < len(addrs) {
				start()
				timer.Reset(fallbackDelay)
			}
		}
	}
	return nil, firstErr
}

// lookup asks every DNS server at once for IPv4 and IPv6 addresses and returns
// as soon as it has something usable.
func (t *Tunnel) lookup(ctx context.Context, host string) (dnsEntry, error) {
	name, err := dnsmessage.NewName(dnsName(host))
	if err != nil {
		return dnsEntry{}, errNoAddress
	}
	type answer struct {
		qtype dnsmessage.Type
		addrs []netip.Addr
		ttl   uint32
		err   error
	}
	qctx, cancel := context.WithCancel(ctx)
	defer cancel()
	ch := make(chan answer, 2)
	ask := func(qtype dnsmessage.Type) {
		addrs, ttl, err := t.query(qctx, name, qtype)
		ch <- answer{qtype, addrs, ttl, err}
	}
	waiting := 0
	if t.hasV4 {
		waiting++
		go ask(dnsmessage.TypeA)
	}
	if t.hasV6 {
		waiting++
		go ask(dnsmessage.TypeAAAA)
	}
	var e dnsEntry
	ttl := uint32(dnsCacheMax / time.Second)
	var firstErr error
	var grace <-chan time.Time
	for waiting > 0 {
		select {
		case a := <-ch:
			waiting--
			if a.err != nil {
				if firstErr == nil {
					firstErr = a.err
				}
				continue
			}
			if a.qtype == dnsmessage.TypeA {
				e.v4 = a.addrs
			} else {
				e.v6 = a.addrs
			}
			if a.ttl < ttl {
				ttl = a.ttl
			}
			if a.qtype == dnsmessage.TypeA && len(a.addrs) > 0 && waiting > 0 {
				grace = time.After(v6Grace)
			}
		case <-grace:
			waiting = 0
		case <-ctx.Done():
			if len(e.v4)+len(e.v6) == 0 {
				return dnsEntry{}, ctx.Err()
			}
			waiting = 0
		}
	}
	if len(e.v4)+len(e.v6) == 0 {
		if firstErr != nil {
			return dnsEntry{}, firstErr
		}
		return dnsEntry{}, errNoAddress
	}
	keep := min(max(time.Duration(ttl)*time.Second, dnsCacheMin), dnsCacheMax)
	e.until = time.Now().Add(keep)
	t.dns.put(host, e)
	return e, nil
}

// query sends one question to every DNS server, again every dnsResend, and
// returns the first real answer.
func (t *Tunnel) query(ctx context.Context, name dnsmessage.Name, qtype dnsmessage.Type) ([]netip.Addr, uint32, error) {
	type reply struct {
		addrs []netip.Addr
		ttl   uint32
		err   error
	}
	ch := make(chan reply, len(t.dnsServers))
	for _, srv := range t.dnsServers {
		go func() {
			addrs, ttl, err := t.askServer(ctx, srv, name, qtype)
			ch <- reply{addrs, ttl, err}
		}()
	}
	var firstErr error
	for range t.dnsServers {
		select {
		case r := <-ch:
			if r.err == nil || errors.Is(r.err, errNoAddress) {
				return r.addrs, r.ttl, r.err
			}
			if firstErr == nil {
				firstErr = r.err
			}
		case <-ctx.Done():
			return nil, 0, ctx.Err()
		}
	}
	return nil, 0, firstErr
}

func (t *Tunnel) askServer(ctx context.Context, srv netip.Addr, name dnsmessage.Name, qtype dnsmessage.Type) ([]netip.Addr, uint32, error) {
	c, err := t.tnet.DialUDPAddrPort(netip.AddrPort{}, netip.AddrPortFrom(srv, 53))
	if err != nil {
		return nil, 0, err
	}
	defer c.Close()
	go func() {
		<-ctx.Done()
		c.SetDeadline(time.Now())
	}()
	id := uint16(rand.Uint32())
	msg := dnsmessage.Message{
		Header:    dnsmessage.Header{ID: id, RecursionDesired: true},
		Questions: []dnsmessage.Question{{Name: name, Type: qtype, Class: dnsmessage.ClassINET}},
	}
	q, err := msg.Pack()
	if err != nil {
		return nil, 0, err
	}
	buf := make([]byte, 4096)
	for ctx.Err() == nil {
		if _, err := c.Write(q); err != nil {
			return nil, 0, err
		}
		c.SetReadDeadline(time.Now().Add(dnsResend))
		for {
			n, err := c.Read(buf)
			if err != nil {
				break // timed out: send again
			}
			addrs, ttl, err := parseAnswer(buf[:n], id, qtype)
			if err == errWrongReply {
				continue
			}
			return addrs, ttl, err
		}
	}
	return nil, 0, ctx.Err()
}

var (
	errWrongReply = errors.New("reply to another question")
	errDNSFailed  = errors.New("DNS server failed")
)

func parseAnswer(b []byte, id uint16, qtype dnsmessage.Type) ([]netip.Addr, uint32, error) {
	var p dnsmessage.Parser
	h, err := p.Start(b)
	if err != nil || h.ID != id || !h.Response {
		return nil, 0, errWrongReply
	}
	switch h.RCode {
	case dnsmessage.RCodeSuccess:
	case dnsmessage.RCodeNameError:
		return nil, 0, errNoAddress
	default:
		return nil, 0, errDNSFailed
	}
	if err := p.SkipAllQuestions(); err != nil {
		return nil, 0, errDNSFailed
	}
	var addrs []netip.Addr
	ttl := uint32(dnsCacheMax / time.Second)
	for {
		rh, err := p.AnswerHeader()
		if err == dnsmessage.ErrSectionDone {
			break
		}
		if err != nil {
			return nil, 0, errDNSFailed
		}
		if rh.TTL < ttl {
			ttl = rh.TTL
		}
		switch {
		case rh.Type == dnsmessage.TypeA && qtype == dnsmessage.TypeA:
			r, err := p.AResource()
			if err != nil {
				return nil, 0, errDNSFailed
			}
			addrs = append(addrs, netip.AddrFrom4(r.A))
		case rh.Type == dnsmessage.TypeAAAA && qtype == dnsmessage.TypeAAAA:
			r, err := p.AAAAResource()
			if err != nil {
				return nil, 0, errDNSFailed
			}
			addrs = append(addrs, netip.AddrFrom16(r.AAAA))
		default:
			if err := p.SkipAnswer(); err != nil {
				return nil, 0, errDNSFailed
			}
		}
	}
	// A name with no addresses of this kind is a valid, empty answer.
	return addrs, ttl, nil
}

func dnsName(host string) string {
	if len(host) > 0 && host[len(host)-1] == '.' {
		return host
	}
	return host + "."
}
