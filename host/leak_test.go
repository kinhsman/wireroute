package main

// DNS leak tests. A site that goes through a server must never be looked up
// on this computer: its name is looked up inside the tunnel (the server's
// DNS), or by the server's relay. Otherwise your internet provider sees which
// sites you visit even though the traffic itself goes through the VPN.
//
// The test swaps this computer's resolver for one that writes down every name
// it is asked about. A first check sends a Direct site through the helper and
// makes sure the watcher sees that lookup, so "no lookups seen" means
// something.

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/net/dns/dnsmessage"
)

// localDNS records every name looked up through this computer's resolver
// and answers 127.0.0.1 for all of them.
type localDNS struct {
	mu    sync.Mutex
	names []string
}

func watchLocalDNS(t *testing.T) *localDNS {
	l := &localDNS{}
	old := net.DefaultResolver
	net.DefaultResolver = &net.Resolver{
		PreferGo: true,
		Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
			a, b := net.Pipe()
			go l.serve(b)
			return a, nil
		},
	}
	t.Cleanup(func() { net.DefaultResolver = old })
	return l
}

// serve answers DNS over a stream (2-byte length, then the message), which
// is what Go's resolver speaks over a connection that isn't a packet one.
func (l *localDNS) serve(c net.Conn) {
	defer c.Close()
	for {
		var n uint16
		if err := binary.Read(c, binary.BigEndian, &n); err != nil {
			return
		}
		buf := make([]byte, n)
		if _, err := io.ReadFull(c, buf); err != nil {
			return
		}
		var p dnsmessage.Parser
		h, err := p.Start(buf)
		if err != nil {
			return
		}
		q, err := p.Question()
		if err != nil {
			return
		}
		l.mu.Lock()
		l.names = append(l.names, strings.TrimSuffix(q.Name.String(), "."))
		l.mu.Unlock()
		resp := dnsmessage.Message{
			Header:    dnsmessage.Header{ID: h.ID, Response: true, RecursionAvailable: true},
			Questions: []dnsmessage.Question{q},
		}
		if q.Type == dnsmessage.TypeA {
			resp.Answers = []dnsmessage.Resource{{
				Header: dnsmessage.ResourceHeader{Name: q.Name, Class: dnsmessage.ClassINET, TTL: 60},
				Body:   &dnsmessage.AResource{A: [4]byte{127, 0, 0, 1}},
			}}
		}
		out, err := resp.Pack()
		if err != nil {
			return
		}
		binary.Write(c, binary.BigEndian, uint16(len(out)))
		c.Write(out)
	}
}

// saw reports whether host was looked up here (search domains included,
// like host.lan).
func (l *localDNS) saw(host string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, n := range l.names {
		if n == host || strings.HasPrefix(n, host+".") {
			return true
		}
	}
	return false
}

func (l *localDNS) all() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.names...)
}

func TestNoDNSLeaks(t *testing.T) {
	local := watchLocalDNS(t)

	// L: a plain server whose DNS (inside the tunnel) knows site.test.
	lPriv, lPub := genKey(t)
	lServerPub, lPort := lambutLikeServer(t, lPub)
	// R: a server with a relay; the relay connects to sites by name itself.
	rPriv, rPub := genKey(t)
	rs, rServerPub, rPort := newRelayServer(t, rPub)
	rs.on()

	direct := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { io.WriteString(w, "direct") }))
	defer direct.Close()
	_, directPort, _ := net.SplitHostPort(direct.Listener.Addr().String())

	h := newHarness(t, &Config{
		Servers: []ServerConf{
			{
				ID: "L", Name: "L",
				PrivateKey: base64.StdEncoding.EncodeToString(lPriv),
				Addresses:  []string{"10.9.0.2/32", "fd00::2/128"},
				DNS:        []string{"10.9.0.1"},
				PublicKey:  base64.StdEncoding.EncodeToString(lServerPub),
				Endpoint:   fmt.Sprintf("127.0.0.1:%d", lPort),
				AllowedIPs: []string{"0.0.0.0/0", "::/0"},
			},
			{
				ID: "R", Name: "R",
				PrivateKey: base64.StdEncoding.EncodeToString(rPriv),
				Addresses:  []string{"10.9.0.2/32"},
				DNS:        []string{"10.9.0.1"},
				PublicKey:  base64.StdEncoding.EncodeToString(rServerPub),
				Endpoint:   fmt.Sprintf("127.0.0.1:%d", rPort),
				AllowedIPs: []string{"0.0.0.0/0", "::/0"},
			},
		},
		Rules: []Rule{
			{ID: "r1", Pattern: "site.test", Route: "L"},
			{ID: "r2", Pattern: "relayed.test", Route: "R"},
			{ID: "r3", Pattern: "gone.test", Route: "missing-server"},
		},
		DefaultRoute: "direct",
		KillSwitch:   true,
		HoldMs:       100,
	})
	waitUp(t, h, "L")
	waitUp(t, h, "R")
	h.m.mu.Lock()
	rTun := h.m.tunnels["R"]
	h.m.mu.Unlock()
	waitRelay(t, rTun, true, 10*time.Second)

	// If this fails, the watcher is blind and the checks below prove nothing.
	t.Run("the watcher sees a Direct site being looked up on this computer", func(t *testing.T) {
		code, body := h.connect(t, "direct.test:"+directPort)
		if code != 200 || body != "direct" {
			t.Fatalf("got %d %q", code, body)
		}
		if !local.saw("direct.test") {
			t.Fatalf("watcher saw no lookup for direct.test (saw %v)", local.all())
		}
	})

	t.Run("https: a site on a server is looked up inside the tunnel", func(t *testing.T) {
		code, body := h.connect(t, "site.test:80")
		if code != 200 || body != "hello from the server" {
			t.Fatalf("got %d %q", code, body)
		}
	})

	t.Run("plain http: same", func(t *testing.T) {
		resp, err := h.client().Get("http://www.site.test/")
		if err == nil {
			resp.Body.Close()
		}
		// www.site.test is unknown to the server's DNS, so it fails; what
		// matters is where it was looked up.
	})

	t.Run("a name the server's DNS doesn't know fails, without asking this computer", func(t *testing.T) {
		if code, _ := h.connect(t, "nosuch.site.test:443"); code == 200 {
			t.Fatal("unknown name connected")
		}
	})

	t.Run("relay: the server looks the name up itself", func(t *testing.T) {
		code, body := h.connect(t, "relayed.test:443")
		if code != 200 || body != "via-relay" {
			t.Fatalf("got %d %q", code, body)
		}
	})

	t.Run("kill switch: a site whose server is gone is blocked, never looked up here", func(t *testing.T) {
		if code, _ := h.connect(t, "gone.test:443"); code == 200 {
			t.Fatal("blocked site connected")
		}
	})

	for _, host := range []string{"site.test", "www.site.test", "nosuch.site.test", "relayed.test", "gone.test"} {
		if local.saw(host) {
			t.Errorf("DNS leak: %s was looked up on this computer (all lookups: %v)", host, local.all())
		}
	}
}
