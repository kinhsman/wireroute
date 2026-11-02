package main

import (
	"bufio"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"testing"
	"time"

	"golang.org/x/crypto/curve25519"
	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun/netstack"
)

// These tests run a real WireGuard "server" inside the test process (no admin
// rights, nothing touches the Mac's network), point the helper at it, and send
// requests through the helper's proxy exactly like Chrome would.

func genKey(t *testing.T) (priv, pub []byte) {
	priv = make([]byte, 32)
	if _, err := rand.Read(priv); err != nil {
		t.Fatal(err)
	}
	priv[0] &= 248
	priv[31] = (priv[31] & 127) | 64
	pub, err := curve25519.X25519(priv, curve25519.Basepoint)
	if err != nil {
		t.Fatal(err)
	}
	return priv, pub
}

func freeUDPPort(t *testing.T) int {
	c, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	return c.LocalAddr().(*net.UDPAddr).Port
}

// fakeServer starts a WireGuard peer at 10.9.0.1 with a web server on port 80
// that answers "via-tunnel <name>".
func fakeServer(t *testing.T, name string, clientPub []byte) (pub []byte, port int, stop func()) {
	priv, pub := genKey(t)
	port = freeUDPPort(t)
	tunDev, tnet, err := netstack.CreateNetTUN([]netip.Addr{netip.MustParseAddr("10.9.0.1")}, nil, 1420)
	if err != nil {
		t.Fatal(err)
	}
	dev := device.NewDevice(tunDev, conn.NewDefaultBind(), device.NewLogger(device.LogLevelSilent, ""))
	cfg := fmt.Sprintf("private_key=%s\nlisten_port=%d\npublic_key=%s\nallowed_ip=10.9.0.2/32\n",
		hex.EncodeToString(priv), port, hex.EncodeToString(clientPub))
	if err := dev.IpcSet(cfg); err != nil {
		t.Fatal(err)
	}
	if err := dev.Up(); err != nil {
		t.Fatal(err)
	}
	ln, err := tnet.ListenTCP(&net.TCPAddr{IP: net.ParseIP("10.9.0.1"), Port: 80})
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "via-tunnel %s", name)
	})}
	go srv.Serve(ln)
	return pub, port, func() { srv.Close(); dev.Close() }
}

type harness struct {
	m    *manager
	port int
}

func newHarness(t *testing.T, cfg *Config) *harness {
	m := newManager(&writer{w: io.Discard})
	port, err := m.proxy.Listen(0)
	if err != nil {
		t.Fatal(err)
	}
	m.applyConfig(cfg)
	t.Cleanup(m.stopAll)
	return &harness{m: m, port: port}
}

func (h *harness) client() *http.Client {
	u := &url.URL{Scheme: "http", Host: fmt.Sprintf("127.0.0.1:%d", h.port)}
	return &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{Proxy: http.ProxyURL(u)}}
}

// connect does what Chrome does for https: CONNECT, then talk through it.
func (h *harness) connect(t *testing.T, target string) (status int, body string) {
	c, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", h.port), 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(10 * time.Second))
	fmt.Fprintf(c, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n", target, target)
	br := bufio.NewReader(c)
	resp, err := http.ReadResponse(br, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 200 {
		return resp.StatusCode, ""
	}
	host, _, _ := net.SplitHostPort(target)
	fmt.Fprintf(c, "GET / HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n\r\n", host)
	inner, err := http.ReadResponse(br, nil)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(inner.Body)
	return 200, string(b)
}

func serverConf(id string, clientPriv, serverPub []byte, port int) ServerConf {
	return ServerConf{
		ID:         id,
		Name:       id,
		PrivateKey: base64.StdEncoding.EncodeToString(clientPriv),
		Addresses:  []string{"10.9.0.2/32"},
		PublicKey:  base64.StdEncoding.EncodeToString(serverPub),
		Endpoint:   fmt.Sprintf("127.0.0.1:%d", port),
		AllowedIPs: []string{"10.9.0.0/24"},
	}
}

func waitUp(t *testing.T, h *harness, id string) {
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		h.m.mu.Lock()
		_, ok := h.m.tunnels[id]
		h.m.mu.Unlock()
		if ok {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("tunnel %s never started: %+v", id, h.m.statuses())
}

func TestEndToEnd(t *testing.T) {
	clientPriv, clientPub := genKey(t)
	serverPub, port, stop := fakeServer(t, "A", clientPub)
	defer stop()

	h := newHarness(t, &Config{
		Servers:      []ServerConf{serverConf("A", clientPriv, serverPub, port)},
		Rules:        []Rule{{ID: "r1", Pattern: "10.9.0.1", Exact: true, Route: "A"}},
		DefaultRoute: "direct",
		KillSwitch:   true,
		HoldMs:       100,
	})
	waitUp(t, h, "A")

	t.Run("https-style CONNECT goes through the tunnel", func(t *testing.T) {
		code, body := h.connect(t, "10.9.0.1:80")
		if code != 200 || body != "via-tunnel A" {
			t.Fatalf("got %d %q", code, body)
		}
	})

	t.Run("plain http goes through the tunnel", func(t *testing.T) {
		resp, err := h.client().Get("http://10.9.0.1/")
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if string(b) != "via-tunnel A" {
			t.Fatalf("got %q", b)
		}
	})

	t.Run("a web page's plain request is refused", func(t *testing.T) {
		// What fetch("http://127.0.0.1:port/") from a site would send.
		resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/", h.port))
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("got %d, want 400", resp.StatusCode)
		}
	})

	t.Run("handshake makes the tunnel report up", func(t *testing.T) {
		h.m.mu.Lock()
		tun := h.m.tunnels["A"]
		h.m.mu.Unlock()
		tun.checkHealth()
		if st := tun.Status(); st.State != "up" || st.LastHandshake == 0 {
			t.Fatalf("status %+v", st)
		}
	})

	t.Run("unclaimed hosts go direct", func(t *testing.T) {
		direct, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		go http.Serve(direct, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { io.WriteString(w, "direct") }))
		defer direct.Close()
		code, body := h.connect(t, direct.Addr().String())
		if code != 200 || body != "direct" {
			t.Fatalf("got %d %q", code, body)
		}
	})
}

func TestKillSwitch(t *testing.T) {
	clientPriv, clientPub := genKey(t)
	serverPub, port, stop := fakeServer(t, "A", clientPub)
	h := newHarness(t, &Config{
		Servers:      []ServerConf{serverConf("A", clientPriv, serverPub, port)},
		Rules:        []Rule{{ID: "r1", Pattern: "10.9.0.1", Exact: true, Route: "A"}},
		DefaultRoute: "direct",
		KillSwitch:   true,
		HoldMs:       100,
	})
	waitUp(t, h, "A")
	if code, _ := h.connect(t, "10.9.0.1:80"); code != 200 {
		t.Fatalf("before outage: got %d", code)
	}

	// Server dies; once the helper notices, the site must be blocked, not sent direct.
	stop()
	h.m.mu.Lock()
	tun := h.m.tunnels["A"]
	h.m.mu.Unlock()
	tun.mu.Lock()
	tun.lastHS = time.Now().Add(-10 * time.Minute).Unix()
	tun.state = "down"
	tun.mu.Unlock()

	code, _ := h.connect(t, "10.9.0.1:80")
	if code != http.StatusServiceUnavailable {
		t.Fatalf("server down: got %d, want 503", code)
	}

	// A rule pointing at a server that doesn't exist is blocked too.
	h.m.applyConfig(&Config{
		Rules:        []Rule{{ID: "r1", Pattern: "10.9.0.1", Exact: true, Route: "missing"}},
		DefaultRoute: "direct",
		KillSwitch:   true,
	})
	if code, _ := h.connect(t, "10.9.0.1:80"); code != http.StatusServiceUnavailable {
		t.Fatalf("missing server: got %d, want 503", code)
	}
}

func TestTwoServersAtOnce(t *testing.T) {
	// Two servers with the same inner address prove each rule really picks its
	// own tunnel: the answer names the server that served it.
	privA, pubA := genKey(t)
	privB, pubB := genKey(t)
	spA, portA, stopA := fakeServer(t, "A", pubA)
	defer stopA()
	spB, portB, stopB := fakeServer(t, "B", pubB)
	defer stopB()

	h := newHarness(t, &Config{
		Servers: []ServerConf{
			serverConf("A", privA, spA, portA),
			serverConf("B", privB, spB, portB),
		},
		Rules:        []Rule{{ID: "r1", Pattern: "10.9.0.1", Exact: true, Route: "A"}},
		DefaultRoute: "B",
		KillSwitch:   true,
		HoldMs:       100,
	})
	waitUp(t, h, "A")
	waitUp(t, h, "B")

	if _, body := h.connect(t, "10.9.0.1:80"); body != "via-tunnel A" {
		t.Fatalf("rule route: got %q", body)
	}

	// Switch the rule to B: live connections are rechecked, new ones use B.
	h.m.applyConfig(&Config{
		Servers: []ServerConf{
			serverConf("A", privA, spA, portA),
			serverConf("B", privB, spB, portB),
		},
		Rules:        []Rule{{ID: "r1", Pattern: "10.9.0.1", Exact: true, Route: "B"}},
		DefaultRoute: "B",
		KillSwitch:   true,
	})
	if _, body := h.connect(t, "10.9.0.1:80"); body != "via-tunnel B" {
		t.Fatalf("after switch: got %q", body)
	}
	h.m.mu.Lock()
	_, aRunning := h.m.tunnels["A"]
	h.m.mu.Unlock()
	if aRunning {
		t.Fatalf("server A should stop once nothing uses it")
	}
}
