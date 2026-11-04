package main

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"sync"
	"testing"
	"time"

	"github.com/sanglam/wireroute/host/relay"
	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun/netstack"
)

// relayServer is a fake WireGuard server at 10.9.0.1 with a web page at a
// public-looking address (203.0.113.7, the relay only takes public ones)
// that says "via-tunnel", plus a relay that can be switched on and off.
// Whatever the relay is asked to reach, it answers "via-relay".
type relayServer struct {
	t     *testing.T
	tnet  *netstack.Net
	site  string // what the relay connects to
	mu    sync.Mutex
	ln    net.Listener
	conns []net.Conn
}

func newRelayServer(t *testing.T, clientPub []byte) (*relayServer, []byte, int) {
	priv, pub := genKey(t)
	port := freeUDPPort(t)
	tunDev, tnet, err := netstack.CreateNetTUN([]netip.Addr{netip.MustParseAddr("10.9.0.1"), netip.MustParseAddr(siteIP)}, nil, 1420)
	if err != nil {
		t.Fatal(err)
	}
	dev := device.NewDevice(tunDev, conn.NewStdNetBind(), device.NewLogger(device.LogLevelSilent, ""))
	cfg := fmt.Sprintf("private_key=%s\nlisten_port=%d\npublic_key=%s\nallowed_ip=10.9.0.2/32\npersistent_keepalive_interval=1\n",
		hex.EncodeToString(priv), port, hex.EncodeToString(clientPub))
	if err := dev.IpcSet(cfg); err != nil {
		t.Fatal(err)
	}
	if err := dev.Up(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(dev.Close)
	web, err := tnet.ListenTCP(&net.TCPAddr{IP: net.ParseIP(siteIP), Port: 80})
	if err != nil {
		t.Fatal(err)
	}
	page := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "via-tunnel") })
	go (&http.Server{Handler: page}).Serve(web)
	web2, err := tnet.ListenTCP(&net.TCPAddr{IP: net.ParseIP("10.9.0.1"), Port: 80})
	if err != nil {
		t.Fatal(err)
	}
	go (&http.Server{Handler: page}).Serve(web2)
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "via-relay")
	}))
	t.Cleanup(site.Close)
	rs := &relayServer{t: t, tnet: tnet, site: site.Listener.Addr().String()}
	t.Cleanup(rs.off)
	return rs, pub, port
}

func (rs *relayServer) on() {
	ln, err := rs.tnet.ListenTCP(&net.TCPAddr{IP: net.ParseIP("10.9.0.1"), Port: relay.Port})
	if err != nil {
		rs.t.Fatal(err)
	}
	rs.mu.Lock()
	rs.ln = ln
	rs.mu.Unlock()
	s := &relay.Server{DialFunc: func(ctx context.Context, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "tcp", rs.site)
	}}
	go s.Serve(trackListener{ln, rs})
}

// off stops the relay and drops every session, like a server restart.
func (rs *relayServer) off() {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	if rs.ln != nil {
		rs.ln.Close()
		rs.ln = nil
	}
	for _, c := range rs.conns {
		c.Close()
	}
	rs.conns = nil
}

type trackListener struct {
	net.Listener
	rs *relayServer
}

func (l trackListener) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err == nil {
		l.rs.mu.Lock()
		l.rs.conns = append(l.rs.conns, c)
		l.rs.mu.Unlock()
	}
	return c, err
}

func relayTunnel(t *testing.T, withRelay bool) (*Tunnel, *relayServer) {
	clientPriv, clientPub := genKey(t)
	rs, serverPub, port := newRelayServer(t, clientPub)
	if withRelay {
		rs.on()
	}
	c := ServerConf{
		ID: "R", Name: "R",
		PrivateKey: base64.StdEncoding.EncodeToString(clientPriv),
		Addresses:  []string{"10.9.0.2/32"},
		DNS:        []string{"10.9.0.1"}, // gives the health knock something to hit
		PublicKey:  base64.StdEncoding.EncodeToString(serverPub),
		Endpoint:   fmt.Sprintf("127.0.0.1:%d", port),
		AllowedIPs: []string{"10.9.0.0/24", siteIP + "/32"},
	}
	tun, err := startTunnel(c, func(TunnelStatus) {})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(tun.Close)
	return tun, rs
}

func fetch(t *testing.T, tun *Tunnel) string { return fetchFrom(t, tun, siteIP+":80") }

func fetchFrom(t *testing.T, tun *Tunnel, target string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, err := tun.Dial(ctx, target)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(5 * time.Second))
	fmt.Fprint(c, "GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
	b, _ := io.ReadAll(c)
	switch s := string(b); {
	case contains(s, "via-relay"):
		return "relay"
	case contains(s, "via-tunnel"):
		return "tunnel"
	default:
		t.Fatalf("unexpected answer %q", s)
		return ""
	}
}

const siteIP = "203.0.113.7"

func TestPrivateAddressesSkipTheRelay(t *testing.T) {
	tun, _ := relayTunnel(t, true)
	waitRelay(t, tun, true, 10*time.Second)
	// The server's own network goes straight through the tunnel; the relay
	// only reaches websites.
	if got := fetchFrom(t, tun, "10.9.0.1:80"); got != "tunnel" {
		t.Fatalf("private address went %s, want tunnel", got)
	}
}

func contains(s, sub string) bool { return len(s) >= len(sub) && indexOf(s, sub) >= 0 }

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

func waitRelay(t *testing.T, tun *Tunnel, want bool, within time.Duration) {
	t.Helper()
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		if tun.UsingRelay() == want {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("relay in use = %v after %s, want %v", tun.UsingRelay(), within, want)
}

func TestHelperFindsAndUsesTheRelay(t *testing.T) {
	tun, _ := relayTunnel(t, true)
	waitRelay(t, tun, true, 10*time.Second)
	for range 3 {
		if got := fetch(t, tun); got != "relay" {
			t.Fatalf("went %s, want relay", got)
		}
	}
	if !tun.Status().Relay {
		t.Fatal("status doesn't say relay")
	}
}

func TestNoRelayMeansStraightThrough(t *testing.T) {
	tun, _ := relayTunnel(t, false)
	time.Sleep(2 * time.Second) // give it time to look
	if got := fetch(t, tun); got != "tunnel" {
		t.Fatalf("went %s, want tunnel", got)
	}
	if tun.UsingRelay() {
		t.Fatal("claims a relay that isn't there")
	}
}

func TestRelayDroppingOutFallsBackThenComesBack(t *testing.T) {
	old := relayRetryBroken
	relayRetryBroken = 300 * time.Millisecond
	defer func() { relayRetryBroken = old }()

	tun, rs := relayTunnel(t, true)
	waitRelay(t, tun, true, 10*time.Second)
	if got := fetch(t, tun); got != "relay" {
		t.Fatalf("went %s, want relay", got)
	}

	rs.off() // the server restarts its relay
	time.Sleep(200 * time.Millisecond)
	for i := range 3 {
		time.Sleep(400 * time.Millisecond) // long enough for the helper to look and miss
		if got := fetch(t, tun); got != "tunnel" {
			t.Fatalf("after relay stopped, try %d went %s, want tunnel (and no error)", i, got)
		}
	}

	rs.on()
	// Found again on the next health check (every 5s) or the next connection.
	deadline := time.Now().Add(12 * time.Second)
	for time.Now().Before(deadline) && fetch(t, tun) != "relay" {
		time.Sleep(500 * time.Millisecond)
	}
	if got := fetch(t, tun); got != "relay" {
		t.Fatalf("relay came back but connections still go %s", got)
	}
}
