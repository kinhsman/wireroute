package main

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun/netstack"
)

// Health timings. With a 25s keepalive WireGuard re-handshakes at least every
// ~2 minutes, so a handshake older than staleAfter means the server is gone.
const (
	defaultKeepalive = 25
	staleAfter       = 180 * time.Second
	startGrace       = 20 * time.Second
	healthEvery      = 5 * time.Second
	reresolveEvery   = 30 * time.Second
)

// Tunnel is one userspace WireGuard connection to one server. It never touches
// the Mac's network settings: traffic only enters it through Dial.
type Tunnel struct {
	conf    ServerConf
	dev     *device.Device
	tnet    *netstack.Net
	peerHex string
	started time.Time
	onState func(TunnelStatus)

	mu        sync.Mutex
	state     string
	errMsg    string
	lastHS    int64
	rx, tx    int64
	endpoint  string // resolved ip:port currently in use
	lastResol time.Time

	stop chan struct{}
	once sync.Once
}

func startTunnel(c ServerConf, onState func(TunnelStatus)) (*Tunnel, error) {
	addrs, err := parseAddrs(c.Addresses)
	if err != nil {
		return nil, err
	}
	dns, err := parseIPs(c.DNS)
	if err != nil {
		return nil, fmt.Errorf("DNS: %w", err)
	}
	if len(dns) == 0 {
		// Without a DNS server the tunnel can't look names up, and falling back
		// to the Mac's own DNS would leak which sites you visit.
		dns = []netip.Addr{netip.MustParseAddr("1.1.1.1")}
	}
	mtu := c.MTU
	if mtu == 0 {
		mtu = 1420
	}
	privHex, err := keyToHex(c.PrivateKey, "private key")
	if err != nil {
		return nil, err
	}
	pubHex, err := keyToHex(c.PublicKey, "server public key")
	if err != nil {
		return nil, err
	}
	endpoint, err := resolveEndpoint(c.Endpoint)
	if err != nil {
		return nil, fmt.Errorf("can't find server %q: %w", c.Endpoint, err)
	}

	var b strings.Builder
	fmt.Fprintf(&b, "private_key=%s\n", privHex)
	fmt.Fprintf(&b, "public_key=%s\n", pubHex)
	if c.PresharedKey != "" {
		pskHex, err := keyToHex(c.PresharedKey, "preshared key")
		if err != nil {
			return nil, err
		}
		fmt.Fprintf(&b, "preshared_key=%s\n", pskHex)
	}
	fmt.Fprintf(&b, "endpoint=%s\n", endpoint)
	keepalive := c.Keepalive
	if keepalive == 0 {
		keepalive = defaultKeepalive
	}
	fmt.Fprintf(&b, "persistent_keepalive_interval=%d\n", keepalive)
	allowed := c.AllowedIPs
	if len(allowed) == 0 {
		allowed = []string{"0.0.0.0/0", "::/0"}
	}
	for _, a := range allowed {
		p, err := netip.ParsePrefix(strings.TrimSpace(a))
		if err != nil {
			return nil, fmt.Errorf("allowed IPs %q: %w", a, err)
		}
		fmt.Fprintf(&b, "allowed_ip=%s\n", p)
	}

	tunDev, tnet, err := netstack.CreateNetTUN(addrs, dns, mtu)
	if err != nil {
		return nil, fmt.Errorf("create tunnel: %w", err)
	}
	logger := &device.Logger{
		Verbosef: func(string, ...any) {},
		Errorf:   func(f string, a ...any) { logf("["+c.Name+"] "+f, a...) },
	}
	dev := device.NewDevice(tunDev, conn.NewDefaultBind(), logger)
	if err := dev.IpcSet(b.String()); err != nil {
		dev.Close()
		return nil, fmt.Errorf("configure tunnel: %w", err)
	}
	if err := dev.Up(); err != nil {
		dev.Close()
		return nil, fmt.Errorf("start tunnel: %w", err)
	}

	t := &Tunnel{
		conf:      c,
		dev:       dev,
		tnet:      tnet,
		peerHex:   pubHex,
		started:   time.Now(),
		onState:   onState,
		state:     "starting",
		endpoint:  endpoint,
		lastResol: time.Now(),
		stop:      make(chan struct{}),
	}
	go t.monitor()
	return t, nil
}

// Dial opens a TCP connection through the tunnel. Names are looked up with the
// tunnel's DNS server, so lookups never go out the normal connection.
func (t *Tunnel) Dial(ctx context.Context, address string) (net.Conn, error) {
	return t.tnet.DialContext(ctx, "tcp", address)
}

// Usable reports whether traffic should be sent into this tunnel.
func (t *Tunnel) Usable() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.state == "starting" || t.state == "up"
}

func (t *Tunnel) Status() TunnelStatus {
	t.mu.Lock()
	defer t.mu.Unlock()
	return TunnelStatus{
		Server:        t.conf.ID,
		State:         t.state,
		Error:         t.errMsg,
		LastHandshake: t.lastHS,
		RxBytes:       t.rx,
		TxBytes:       t.tx,
	}
}

func (t *Tunnel) Close() {
	t.once.Do(func() {
		close(t.stop)
		t.dev.Close()
	})
}

func (t *Tunnel) monitor() {
	tick := time.NewTicker(healthEvery)
	defer tick.Stop()
	for {
		t.checkHealth()
		select {
		case <-t.stop:
			return
		case <-tick.C:
		}
	}
}

func (t *Tunnel) checkHealth() {
	hs, rx, tx := t.readStats()
	now := time.Now()

	t.mu.Lock()
	prev := t.state
	t.lastHS, t.rx, t.tx = hs, rx, tx
	switch {
	case hs > 0 && now.Sub(time.Unix(hs, 0)) < staleAfter:
		t.state = "up"
	case now.Sub(t.started) < startGrace:
		t.state = "starting"
	default:
		t.state = "down"
	}
	state := t.state
	needResolve := state == "down" && now.Sub(t.lastResol) > reresolveEvery
	t.mu.Unlock()

	if needResolve {
		t.reresolve()
	}
	if state != prev && t.onState != nil {
		t.onState(t.Status())
	}
}

// reresolve handles home servers on dynamic DNS: when the server goes quiet,
// look its name up again in case its internet address changed.
func (t *Tunnel) reresolve() {
	t.mu.Lock()
	t.lastResol = time.Now()
	t.mu.Unlock()
	ep, err := resolveEndpoint(t.conf.Endpoint)
	if err != nil {
		return
	}
	t.mu.Lock()
	changed := ep != t.endpoint
	t.endpoint = ep
	t.mu.Unlock()
	if changed {
		logf("[%s] server address changed, reconnecting", t.conf.Name)
		_ = t.dev.IpcSet(fmt.Sprintf("public_key=%s\nupdate_only=true\nendpoint=%s\n", t.peerHex, ep))
	}
}

func (t *Tunnel) readStats() (hs, rx, tx int64) {
	out, err := t.dev.IpcGet()
	if err != nil {
		return
	}
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		k, v, ok := strings.Cut(sc.Text(), "=")
		if !ok {
			continue
		}
		n, _ := strconv.ParseInt(v, 10, 64)
		switch k {
		case "last_handshake_time_sec":
			hs = n
		case "rx_bytes":
			rx = n
		case "tx_bytes":
			tx = n
		}
	}
	return
}

// ExitCheck asks Cloudflare, through the tunnel, which IP and country the
// world sees. It proves the tunnel works end to end.
func (t *Tunnel) ExitCheck(ctx context.Context) (ip, loc string, err error) {
	return cfTrace(ctx, t.Dial)
}

// DirectCheck is ExitCheck for your normal connection, to compare against.
func DirectCheck(ctx context.Context) (ip, loc string, err error) {
	d := net.Dialer{Timeout: 10 * time.Second}
	return cfTrace(ctx, func(ctx context.Context, addr string) (net.Conn, error) {
		return d.DialContext(ctx, "tcp", addr)
	})
}

func cfTrace(ctx context.Context, dial func(context.Context, string) (net.Conn, error)) (ip, loc string, err error) {
	client := &http.Client{
		Timeout: 10 * time.Second,
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, addr string) (net.Conn, error) {
				return dial(ctx, addr)
			},
		},
	}
	req, _ := http.NewRequestWithContext(ctx, "GET", "https://www.cloudflare.com/cdn-cgi/trace", nil)
	resp, err := client.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8192))
	if err != nil {
		return "", "", err
	}
	for _, line := range strings.Split(string(body), "\n") {
		if v, ok := strings.CutPrefix(line, "ip="); ok {
			ip = v
		}
		if v, ok := strings.CutPrefix(line, "loc="); ok {
			loc = v
		}
	}
	if ip == "" {
		return "", "", fmt.Errorf("unexpected answer from check service")
	}
	return ip, loc, nil
}

// --- parsing helpers ---

func keyToHex(b64, what string) (string, error) {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(b64))
	if err != nil || len(raw) != 32 {
		return "", fmt.Errorf("%s is not a valid WireGuard key", what)
	}
	return hex.EncodeToString(raw), nil
}

// parseAddrs accepts "10.0.0.2/32" or a bare "10.0.0.2".
func parseAddrs(list []string) ([]netip.Addr, error) {
	var out []netip.Addr
	for _, s := range list {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		if p, err := netip.ParsePrefix(s); err == nil {
			out = append(out, p.Addr())
			continue
		}
		a, err := netip.ParseAddr(s)
		if err != nil {
			return nil, fmt.Errorf("address %q is not valid", s)
		}
		out = append(out, a)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("the config has no Address")
	}
	return out, nil
}

func parseIPs(list []string) ([]netip.Addr, error) {
	var out []netip.Addr
	for _, s := range list {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		a, err := netip.ParseAddr(s)
		if err != nil {
			// wg-quick allows search domains in DNS=; they don't apply here.
			continue
		}
		out = append(out, a)
	}
	return out, nil
}

// resolveEndpoint turns "host:port" into "ip:port"; WireGuard only takes IPs.
func resolveEndpoint(ep string) (string, error) {
	host, port, err := net.SplitHostPort(strings.TrimSpace(ep))
	if err != nil {
		return "", err
	}
	if a, err := netip.ParseAddr(host); err == nil {
		return netip.AddrPortFrom(a, mustPort(port)).String(), nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ips, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	if err != nil || len(ips) == 0 {
		return "", fmt.Errorf("lookup failed")
	}
	// Prefer IPv4: home connections often have broken IPv6 inbound.
	best := ips[0]
	for _, ip := range ips {
		if ip.Unmap().Is4() {
			best = ip.Unmap()
			break
		}
	}
	return netip.AddrPortFrom(best, mustPort(port)).String(), nil
}

func mustPort(p string) uint16 {
	n, _ := strconv.ParseUint(p, 10, 16)
	return uint16(n)
}
