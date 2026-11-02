package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// The helper is started by Chrome (native messaging) when the extension
// connects, and exits when Chrome closes the connection. It runs the
// WireGuard tunnels and the local proxy that decides, per connection, which
// way traffic goes.

var logger *log.Logger

func logf(format string, args ...any) {
	if logger != nil {
		logger.Printf(format, args...)
	}
}

func openLog() {
	home, err := os.UserHomeDir()
	if err != nil {
		return
	}
	dir := filepath.Join(home, "Library", "Logs", "WireRoute")
	_ = os.MkdirAll(dir, 0o700)
	path := filepath.Join(dir, "helper.log")
	if st, err := os.Stat(path); err == nil && st.Size() > 1<<20 {
		_ = os.Rename(path, path+".old")
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	logger = log.New(f, "", log.LstdFlags)
}

// manager owns the running tunnels and keeps them in line with the config.
type manager struct {
	out    *writer
	router *Router
	proxy  *Proxy

	mu       sync.Mutex
	cfg      *Config
	tunnels  map[string]*Tunnel
	confs    map[string]string // server ID -> JSON of the conf the tunnel runs
	failures map[string]TunnelStatus
	starting map[string]bool
}

func newManager(out *writer) *manager {
	r := NewRouter()
	return &manager{
		out:      out,
		router:   r,
		proxy:    NewProxy(r),
		tunnels:  map[string]*Tunnel{},
		confs:    map[string]string{},
		failures: map[string]TunnelStatus{},
		starting: map[string]bool{},
	}
}

// usedServers is every server some rule or the default route points at.
// Unused servers stay off.
func usedServers(c *Config) map[string]ServerConf {
	byID := map[string]ServerConf{}
	for _, s := range c.Servers {
		byID[s.ID] = s
	}
	used := map[string]ServerConf{}
	add := func(route string) {
		if s, ok := byID[route]; ok {
			used[route] = s
		}
	}
	add(c.DefaultRoute)
	for _, r := range c.Rules {
		add(r.Route)
	}
	return used
}

func (m *manager) applyConfig(c *Config) {
	m.router.SetConfig(c)
	m.mu.Lock()
	m.cfg = c
	m.mu.Unlock()
	m.syncTunnels()
	m.proxy.Recheck()
}

func (m *manager) syncTunnels() {
	m.mu.Lock()
	if m.cfg == nil {
		m.mu.Unlock()
		return
	}
	used := usedServers(m.cfg)
	// Stop tunnels that are no longer used or whose settings changed.
	for id, t := range m.tunnels {
		s, ok := used[id]
		if !ok || confKey(s) != m.confs[id] {
			t.Close()
			delete(m.tunnels, id)
			delete(m.confs, id)
		}
	}
	for id := range m.failures {
		if _, ok := used[id]; !ok {
			delete(m.failures, id)
		}
	}
	var toStart []ServerConf
	for id, s := range used {
		if _, running := m.tunnels[id]; !running && !m.starting[id] {
			m.starting[id] = true
			toStart = append(toStart, s)
		}
	}
	m.publishLocked()
	m.mu.Unlock()

	for _, s := range toStart {
		go m.start(s)
	}
}

func (m *manager) start(s ServerConf) {
	t, err := startTunnel(s, func(st TunnelStatus) {
		m.out.send(Outgoing{Type: "tunnel", Tunnel: &st})
	})
	m.mu.Lock()
	delete(m.starting, s.ID)
	used := m.cfg != nil && func() bool { _, ok := usedServers(m.cfg)[s.ID]; return ok }()
	if err != nil {
		logf("[%s] start failed: %v", s.Name, err)
		st := TunnelStatus{Server: s.ID, State: "error", Error: err.Error()}
		m.failures[s.ID] = st
		m.mu.Unlock()
		m.out.send(Outgoing{Type: "tunnel", Tunnel: &st})
		return
	}
	if !used || confKey(usedServers(m.cfg)[s.ID]) != confKey(s) {
		// Config changed while we were starting; drop this one, sync again.
		m.mu.Unlock()
		t.Close()
		m.syncTunnels()
		return
	}
	delete(m.failures, s.ID)
	m.tunnels[s.ID] = t
	m.confs[s.ID] = confKey(s)
	m.publishLocked()
	m.mu.Unlock()
	st := t.Status()
	m.out.send(Outgoing{Type: "tunnel", Tunnel: &st})
	m.proxy.Recheck()
}

func (m *manager) publishLocked() {
	cp := make(map[string]*Tunnel, len(m.tunnels))
	for k, v := range m.tunnels {
		cp[k] = v
	}
	kill := true
	if m.cfg != nil {
		kill = m.cfg.KillSwitch
	}
	m.proxy.SetTunnels(cp, kill)
}

// retryLoop restarts servers that failed to start (no internet yet, server
// asleep) every 30 seconds.
func (m *manager) retryLoop() {
	for range time.Tick(30 * time.Second) {
		m.mu.Lock()
		failed := len(m.failures) > 0
		m.failures = map[string]TunnelStatus{}
		m.mu.Unlock()
		if failed {
			m.syncTunnels()
		}
	}
}

func (m *manager) statuses() []TunnelStatus {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []TunnelStatus{}
	for _, t := range m.tunnels {
		out = append(out, t.Status())
	}
	for _, f := range m.failures {
		out = append(out, f)
	}
	for id := range m.starting {
		out = append(out, TunnelStatus{Server: id, State: "starting"})
	}
	return out
}

func (m *manager) stopAll() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, t := range m.tunnels {
		t.Close()
		delete(m.tunnels, id)
	}
}

func confKey(s ServerConf) string {
	b, _ := json.Marshal(s)
	return string(b)
}

func (m *manager) handle(msg *Incoming) {
	reply := func(o Outgoing) {
		o.ID = msg.ID
		m.out.send(o)
	}
	switch msg.Cmd {
	case "ping":
		reply(Outgoing{Type: "pong", Version: Version})

	case "hello":
		port, err := m.proxy.Listen(msg.Port)
		if err != nil {
			reply(Outgoing{Type: "error", Error: "can't open local port: " + err.Error()})
			return
		}
		reply(Outgoing{Type: "hello", Version: Version, Port: port})

	case "config":
		if msg.Config == nil {
			reply(Outgoing{Type: "error", Error: "missing config"})
			return
		}
		m.applyConfig(msg.Config)
		reply(Outgoing{Type: "ok"})

	case "hint":
		m.router.Hint(msg.Host, msg.Rule)
		m.proxy.Recheck()

	case "status":
		reply(Outgoing{Type: "status", Port: m.proxy.Port(), Tunnels: m.statuses()})

	case "check":
		m.mu.Lock()
		t := m.tunnels[msg.Server]
		m.mu.Unlock()
		if t == nil {
			reply(Outgoing{Type: "error", Error: "that server isn't connected"})
			return
		}
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
			defer cancel()
			ip, loc, err := t.ExitCheck(ctx)
			if err != nil {
				reply(Outgoing{Type: "error", Error: "check failed: " + err.Error()})
				return
			}
			direct, _, _ := DirectCheck(ctx)
			reply(Outgoing{Type: "check", IP: ip, Loc: loc, DirectIP: direct})
		}()

	default:
		reply(Outgoing{Type: "error", Error: fmt.Sprintf("unknown command %q", msg.Cmd)})
	}
}

func main() {
	openLog()
	logf("helper %s started", Version)
	m := newManager(&writer{w: os.Stdout})
	go m.retryLoop()
	for {
		msg, err := readMessage(os.Stdin)
		if err != nil {
			// Chrome closed the connection (browser quit or extension reloaded).
			logf("exiting: %v", err)
			m.stopAll()
			return
		}
		m.handle(msg)
	}
}
