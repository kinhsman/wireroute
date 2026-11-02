package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"sync"
	"time"
)

// errBlocked means the site's server is down and the kill switch stopped the
// connection from going out the normal way.
var errBlocked = errors.New("blocked by kill switch: this site's VPN server is down")

// Proxy is the local HTTP proxy Chrome sends traffic to. It only listens on
// 127.0.0.1. There's no password: Chrome sends some traffic extensions can't
// see (new tab page, other extensions, incognito), and a password challenge on
// that traffic pops up a sign-in box the extension can't answer. Web pages
// can't use it either: they can't send CONNECT or absolute-URL requests.
type Proxy struct {
	router *Router

	mu         sync.Mutex
	tunnels    map[string]*Tunnel
	groups     map[string][]string // group ID -> server IDs, in failover order
	killSwitch bool
	conns      map[*tracked]struct{}
	transports map[string]*http.Transport
	byServer   map[string]map[*serverConn]struct{} // open connections per server

	ln   net.Listener
	port int

	recent []Decision // last decisions, newest last; for the UI and tests
}

// Decision is one routing choice the proxy made.
type Decision struct {
	Host  string `json:"host"`
	Route string `json:"route"`         // direct, a server or group ID, or "blocked"
	Via   string `json:"via,omitempty"` // the server actually used, for groups
	Why   string `json:"why"`
	At    int64  `json:"at"` // unix milliseconds
}

const maxRecent = 500

func (p *Proxy) record(host, route, via, why string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.recent = append(p.recent, Decision{Host: normHost(host), Route: route, Via: via, Why: why, At: time.Now().UnixMilli()})
	if len(p.recent) > maxRecent {
		p.recent = p.recent[len(p.recent)-maxRecent:]
	}
}

// Recent returns a copy of the latest decisions.
func (p *Proxy) Recent() []Decision {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]Decision(nil), p.recent...)
}

type tracked struct {
	host   string
	route  string
	client net.Conn
	remote net.Conn
}

func NewProxy(router *Router) *Proxy {
	return &Proxy{
		router:     router,
		tunnels:    map[string]*Tunnel{},
		killSwitch: true,
		conns:      map[*tracked]struct{}{},
		transports: map[string]*http.Transport{},
		byServer:   map[string]map[*serverConn]struct{}{},
	}
}

// Listen starts serving on 127.0.0.1:port, or any free port if that's taken.
func (p *Proxy) Listen(port int) (int, error) {
	p.mu.Lock()
	if p.ln != nil {
		defer p.mu.Unlock()
		return p.port, nil
	}
	p.mu.Unlock()

	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		ln, err = net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return 0, err
		}
	}
	srv := &http.Server{Handler: p, ReadHeaderTimeout: 30 * time.Second}
	go func() { _ = srv.Serve(ln) }()

	p.mu.Lock()
	defer p.mu.Unlock()
	p.ln = ln
	p.port = ln.Addr().(*net.TCPAddr).Port
	return p.port, nil
}

func (p *Proxy) Port() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.port
}

func (p *Proxy) SetTunnels(t map[string]*Tunnel, groups map[string][]string, killSwitch bool) {
	p.mu.Lock()
	p.tunnels = t
	p.groups = groups
	p.killSwitch = killSwitch
	p.mu.Unlock()
}

// Pick is the server a new connection on route would use right now: the
// server itself, or for a group the first member that's up (else the first
// still starting). "" means nothing usable.
func (p *Proxy) Pick(route string) string {
	p.mu.Lock()
	defer p.mu.Unlock()
	id, _ := p.pickLocked(route)
	return id
}

func (p *Proxy) pickLocked(route string) (string, *Tunnel) {
	members, isGroup := p.groups[route]
	if !isGroup {
		if t := p.tunnels[route]; t != nil && t.Usable() {
			return route, t
		}
		return "", nil
	}
	for _, want := range []string{"up", "starting"} {
		for _, id := range members {
			if t := p.tunnels[id]; t != nil && t.State() == want {
				return id, t
			}
		}
	}
	return "", nil
}

// Recheck closes live connections whose route no longer matches, e.g. after a
// rule changed or a hint moved a host to another server. Chrome reconnects and
// the new connection takes the right path.
func (p *Proxy) Recheck() {
	p.mu.Lock()
	var stale []*tracked
	for c := range p.conns {
		if p.router.Peek(c.host) != c.route {
			stale = append(stale, c)
		}
	}
	transports := make([]*http.Transport, 0, len(p.transports))
	for _, t := range p.transports {
		transports = append(transports, t)
	}
	p.mu.Unlock()
	for _, c := range stale {
		c.client.Close()
		c.remote.Close()
	}
	for _, t := range transports {
		t.CloseIdleConnections()
	}
}

// serverConn is a connection through one server's tunnel, tracked so all of
// them can be cut when that server goes down.
type serverConn struct {
	net.Conn
	p      *Proxy
	server string
	once   sync.Once
}

func (c *serverConn) Close() error {
	c.once.Do(func() {
		c.p.mu.Lock()
		delete(c.p.byServer[c.server], c)
		c.p.mu.Unlock()
	})
	return c.Conn.Close()
}

// DropServer cuts every open connection through a server that went down.
// Chrome reconnects (it retries requests on reused connections), and the new
// connections take the next server in the group, or get blocked.
func (p *Proxy) DropServer(server string) {
	p.mu.Lock()
	var cs []*serverConn
	for c := range p.byServer[server] {
		cs = append(cs, c)
	}
	transports := make([]*http.Transport, 0, len(p.transports))
	for _, t := range p.transports {
		transports = append(transports, t)
	}
	p.mu.Unlock()
	for _, c := range cs {
		c.Close()
	}
	for _, t := range transports {
		t.CloseIdleConnections()
	}
	if len(cs) > 0 {
		logf("server %s down: cut %d connections", server, len(cs))
	}
}

// dial connects to addr on route and says which server carried it ("" when
// it went direct).
func (p *Proxy) dial(ctx context.Context, route, addr string) (net.Conn, string, error) {
	if route == RouteDirect {
		d := net.Dialer{Timeout: 15 * time.Second}
		c, err := d.DialContext(ctx, "tcp", addr)
		return c, "", err
	}
	p.mu.Lock()
	via, t := p.pickLocked(route)
	kill := p.killSwitch
	p.mu.Unlock()
	if t == nil {
		if kill {
			return nil, "", errBlocked
		}
		d := net.Dialer{Timeout: 15 * time.Second}
		c, err := d.DialContext(ctx, "tcp", addr)
		return c, "", err
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	c, err := t.Dial(ctx, addr)
	if err != nil {
		return nil, via, err
	}
	sc := &serverConn{Conn: c, p: p, server: via}
	p.mu.Lock()
	if p.byServer[via] == nil {
		p.byServer[via] = map[*serverConn]struct{}{}
	}
	p.byServer[via][sc] = struct{}{}
	p.mu.Unlock()
	return sc, via, nil
}

func (p *Proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodConnect {
		p.handleConnect(w, r)
		return
	}
	p.handleHTTP(w, r)
}

func (p *Proxy) handleConnect(w http.ResponseWriter, r *http.Request) {
	host, _, err := net.SplitHostPort(r.Host)
	if err != nil {
		http.Error(w, "bad CONNECT target", http.StatusBadRequest)
		return
	}
	route, why := p.router.DecideWhy(r.Context(), host)
	remote, via, err := p.dial(r.Context(), route, r.Host)
	if errors.Is(err, errBlocked) {
		p.record(host, "blocked", "", why)
	} else {
		p.record(host, route, via, why)
	}
	if err != nil {
		code := http.StatusBadGateway
		if errors.Is(err, errBlocked) {
			code = http.StatusServiceUnavailable
		}
		http.Error(w, err.Error(), code)
		return
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		remote.Close()
		http.Error(w, "hijack unsupported", http.StatusInternalServerError)
		return
	}
	client, buf, err := hj.Hijack()
	if err != nil {
		remote.Close()
		return
	}
	if _, err := client.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n")); err != nil {
		client.Close()
		remote.Close()
		return
	}
	// Anything Chrome sent after the CONNECT headers is already buffered.
	if n := buf.Reader.Buffered(); n > 0 {
		pending, _ := buf.Reader.Peek(n)
		if _, err := remote.Write(pending); err != nil {
			client.Close()
			remote.Close()
			return
		}
	}
	p.pipe(&tracked{host: normHost(host), route: route, client: client, remote: remote})
}

func (p *Proxy) pipe(c *tracked) {
	p.mu.Lock()
	p.conns[c] = struct{}{}
	p.mu.Unlock()
	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(c.remote, c.client); done <- struct{}{} }()
	go func() { _, _ = io.Copy(c.client, c.remote); done <- struct{}{} }()
	<-done
	c.client.Close()
	c.remote.Close()
	<-done
	p.mu.Lock()
	delete(p.conns, c)
	p.mu.Unlock()
}

// handleHTTP forwards plain http:// requests (Chrome sends these to the proxy
// with the full URL).
func (p *Proxy) handleHTTP(w http.ResponseWriter, r *http.Request) {
	if !r.URL.IsAbs() {
		http.Error(w, "this is a proxy", http.StatusBadRequest)
		return
	}
	route, why := p.router.DecideWhy(r.Context(), r.URL.Hostname())
	p.record(r.URL.Hostname(), route, p.Pick(route), why)
	rp := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.Out.URL = r.URL
			pr.Out.Host = r.Host
		},
		Transport: p.transport(route),
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			code := http.StatusBadGateway
			if errors.Is(err, errBlocked) {
				code = http.StatusServiceUnavailable
			}
			http.Error(w, err.Error(), code)
		},
	}
	rp.ServeHTTP(w, r)
}

func (p *Proxy) transport(route string) *http.Transport {
	p.mu.Lock()
	defer p.mu.Unlock()
	if t, ok := p.transports[route]; ok {
		return t
	}
	t := &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, _, addr string) (net.Conn, error) {
			c, _, err := p.dial(ctx, route, addr)
			return c, err
		},
		MaxIdleConnsPerHost: 4,
		IdleConnTimeout:     60 * time.Second,
	}
	p.transports[route] = t
	return t
}
