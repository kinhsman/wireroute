package main

// Using a server's relay (see relay/relay.go) when it has one.
//
// Nothing to set up: once a tunnel is up, the helper knocks on the relay port
// at the server's usual VPN address (the .1 of your own VPN address, which is
// what wg-easy uses). If a relay answers, connections go through it; if not,
// or if it breaks, they go straight through the tunnel as before and the
// helper looks again later.

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"time"

	"github.com/sanglam/wireroute/host/relay"
)

const relayConnectWait = 6 * time.Second

var (
	relayRetryAbsent = 5 * time.Minute  // no relay on this server: look again later
	relayRetryBroken = 10 * time.Second // it was there and dropped: reconnect soon
)

// relayCandidates are the addresses a relay may listen on: the .1 of each of
// our own IPv4 VPN addresses.
func relayCandidates(own []netip.Addr) []string {
	var out []string
	for _, a := range own {
		if !a.Is4() {
			continue
		}
		b := a.As4()
		b[3] = 1
		if s := netip.AddrFrom4(b); s != a {
			out = append(out, netip.AddrPortFrom(s, relay.Port).String())
		}
	}
	return out
}

// relaySession returns the live relay session, or nil (and starts looking
// for one in the background when it's time).
func (t *Tunnel) relaySession() *relay.Session {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.relay != nil && !t.relay.Closed() {
		return t.relay
	}
	if t.relay != nil {
		t.relay = nil
		t.relayNext = time.Now().Add(relayRetryBroken)
		logf("[%s] relay connection ended", t.conf.Name)
	}
	if !t.relayLooking && time.Now().After(t.relayNext) && t.state == "up" && len(t.relayAddrs) > 0 {
		t.relayLooking = true
		go t.findRelay()
	}
	return nil
}

func (t *Tunnel) findRelay() {
	var found *relay.Session
	var at string
	for _, addr := range t.relayAddrs {
		ctx, cancel := context.WithTimeout(context.Background(), relayConnectWait)
		c, err := t.dialTCP(ctx, addr)
		if err == nil {
			found, err = relay.Connect(ctx, c)
		}
		cancel()
		if err == nil {
			at = addr
			break
		}
	}
	t.mu.Lock()
	t.relayLooking = false
	select {
	case <-t.stop:
		t.mu.Unlock()
		if found != nil {
			found.Close()
		}
		return
	default:
	}
	if found == nil {
		// A server that had a relay is probably restarting it: look again
		// soon, backing off. One that never had one: every few minutes.
		wait := relayRetryAbsent
		if t.relaySeen {
			t.relayMisses++
			wait = min(relayRetryBroken<<min(t.relayMisses, 10), relayRetryAbsent)
		}
		t.relayNext = time.Now().Add(wait)
		if t.relayLogged != "absent" {
			logf("[%s] no relay on this server, connecting straight through", t.conf.Name)
			t.relayLogged = "absent"
		}
		t.mu.Unlock()
		return
	}
	t.relay = found
	t.relaySeen = true
	t.relayMisses = 0
	t.relayLogged = "found"
	t.mu.Unlock()
	logf("[%s] relay found at %s", t.conf.Name, at)
	if t.onState != nil {
		t.onState(t.Status())
	}
}

// dropRelay forgets a relay session that failed.
func (t *Tunnel) dropRelay(s *relay.Session, why error) {
	s.Close()
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.relay == s {
		t.relay = nil
		t.relayNext = time.Now().Add(relayRetryBroken)
		logf("[%s] relay failed (%v), connecting straight through", t.conf.Name, why)
	}
}

// closeRelay ends the relay session, and with it every connection on it.
func (t *Tunnel) closeRelay() {
	t.mu.Lock()
	s := t.relay
	t.relay = nil
	t.mu.Unlock()
	if s != nil {
		s.Close()
	}
}

// dialVia connects through the relay when there is one, else straight
// through the tunnel.
func (t *Tunnel) dialVia(ctx context.Context, address string) (net.Conn, error) {
	if s := t.relaySession(); s != nil {
		c, err := s.Dial(ctx, address)
		if err == nil || !errors.Is(err, relay.ErrRelay) {
			return c, err
		}
		t.dropRelay(s, err)
	}
	return t.dialTCP(ctx, address)
}

// UsingRelay reports whether connections currently go through a relay.
func (t *Tunnel) UsingRelay() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.relay != nil && !t.relay.Closed()
}
