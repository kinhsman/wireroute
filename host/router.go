package main

import (
	"context"
	"net/netip"
	"strings"
	"sync"
	"time"
)

// How long a "this host was asked for by that site" hint stays authoritative.
const hintTTL = 2 * time.Minute

// How long to remember that nobody claimed a host (Chrome's own traffic, other
// extensions), so its connections don't wait for a hint every time.
const unclaimedTTL = 30 * time.Minute

// Router decides, for every new connection, which way it goes: direct or
// through one server. Its inputs, strongest first:
//
//  1. A rule written for the host itself (cnn.com, or exactly edition.cnn.com).
//  2. A fresh hint from the extension: "a tv360.vn tab just asked for
//     video.viettel.vn". A hint tied to a rule beats one that isn't.
//  3. A learned host: one a ruled site used before.
//  4. Otherwise, wait briefly for a hint, then use the default route.
type Router struct {
	mu        sync.Mutex
	exact     map[string]*Rule
	suffix    map[string]*Rule
	byID      map[string]*Rule
	learned   map[string]string
	hints     map[string]hint
	unclaimed map[string]time.Time
	waiters   map[string][]chan struct{}
	def       string
	lanDirect bool
	hold      time.Duration
	now       func() time.Time
}

type hint struct {
	rule string // "" when the asking site has no rule
	at   time.Time
}

func NewRouter() *Router {
	return &Router{
		exact:     map[string]*Rule{},
		suffix:    map[string]*Rule{},
		byID:      map[string]*Rule{},
		learned:   map[string]string{},
		hints:     map[string]hint{},
		unclaimed: map[string]time.Time{},
		waiters:   map[string][]chan struct{}{},
		def:       RouteDirect,
		hold:      time.Second,
		now:       time.Now,
	}
}

func (r *Router) SetConfig(c *Config) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.exact = map[string]*Rule{}
	r.suffix = map[string]*Rule{}
	r.byID = map[string]*Rule{}
	for i := range c.Rules {
		rule := c.Rules[i]
		p := normHost(rule.Pattern)
		if p == "" {
			continue
		}
		rule.Pattern = p
		r.byID[rule.ID] = &rule
		if rule.Exact {
			r.exact[p] = &rule
		} else {
			r.suffix[p] = &rule
		}
	}
	r.learned = map[string]string{}
	for h, id := range c.Learned {
		h = normHost(h)
		r.learned[h] = id
		// A hint from before this change (say, from when the site had no rule)
		// must not keep the host on its old route; the next request from the
		// site sends a fresh one.
		if hi, ok := r.hints[h]; ok && hi.rule != id {
			delete(r.hints, h)
		}
	}
	r.def = c.DefaultRoute
	if r.def == "" {
		r.def = RouteDirect
	}
	r.lanDirect = c.LanDirect
	if c.HoldMs > 0 {
		r.hold = time.Duration(c.HoldMs) * time.Millisecond
	}
}

// Hint records which site asked for host and wakes anyone waiting on it.
// ruleID is "" when the asking site has no rule.
func (r *Router) Hint(host, ruleID string) {
	host = normHost(host)
	if host == "" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.now()
	if old, ok := r.hints[host]; ok && old.rule != "" && old.rule != ruleID && now.Sub(old.at) < hintTTL {
		// A ruled site claimed this host recently. Another tab touching the
		// same address must not pull it away: switching would cut the first
		// site's live connections (a playing video would stall).
		r.wakeLocked(host)
		return
	}
	r.hints[host] = hint{rule: ruleID, at: now}
	if ruleID != "" {
		if _, claimed := r.learned[host]; !claimed {
			r.learned[host] = ruleID
		}
	}
	r.wakeLocked(host)
	if len(r.hints) > 20000 {
		r.pruneLocked(now)
	}
}

func (r *Router) wakeLocked(host string) {
	for _, ch := range r.waiters[host] {
		close(ch)
	}
	delete(r.waiters, host)
}

func (r *Router) pruneLocked(now time.Time) {
	for h, hi := range r.hints {
		if now.Sub(hi.at) > hintTTL {
			delete(r.hints, h)
		}
	}
}

// Decide returns the route for a new connection to host, waiting up to the
// hold time for a hint when nothing is known yet.
func (r *Router) Decide(ctx context.Context, host string) string {
	route, _ := r.DecideWhy(ctx, host)
	return route
}

// DecideWhy is Decide plus the reason: local, rule, hint, learned,
// unclaimed or waited (nobody claimed it within the hold time).
func (r *Router) DecideWhy(ctx context.Context, host string) (route, why string) {
	host = normHost(host)
	route, why, known, wait := r.lookup(host, true)
	if known || wait == nil {
		return route, why
	}
	timer := time.NewTimer(r.hold)
	defer timer.Stop()
	select {
	case <-wait:
	case <-timer.C:
	case <-ctx.Done():
	}
	route, why, known, _ = r.lookup(host, false)
	if !known {
		why = "waited"
		// Remember that nobody claimed it so the next connection doesn't wait.
		r.mu.Lock()
		r.unclaimed[host] = r.now()
		if len(r.unclaimed) > 20000 {
			r.unclaimed = map[string]time.Time{}
		}
		r.mu.Unlock()
	}
	return route, why
}

// Explain says how a new connection to host would go right now, without
// waiting: the route, why, and which site rule decided it (if any).
func (r *Router) Explain(host string) (route, why, ruleID string) {
	host = normHost(host)
	route, why, _, _ = r.lookup(host, false)
	r.mu.Lock()
	defer r.mu.Unlock()
	switch why {
	case "rule":
		ruleID = r.matchRuleLocked(host).ID
	case "hint":
		ruleID = r.hints[host].rule
	case "learned":
		ruleID = r.learned[host]
	}
	return route, why, ruleID
}

// Peek is Decide without waiting; used to re-check live connections.
func (r *Router) Peek(host string) string {
	route, _, _, _ := r.lookup(normHost(host), false)
	return route
}

func (r *Router) lookup(host string, register bool) (route, why string, known bool, wait chan struct{}) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if host == "" {
		return r.def, "default", true, nil
	}
	if r.lanDirect && isLocal(host) {
		return RouteDirect, "local", true, nil
	}
	if rule := r.matchRuleLocked(host); rule != nil {
		return rule.Route, "rule", true, nil
	}
	if hi, ok := r.hints[host]; ok && r.now().Sub(hi.at) < hintTTL {
		return r.ruleRouteLocked(hi.rule), "hint", true, nil
	}
	if id, ok := r.learned[host]; ok {
		if _, exists := r.byID[id]; exists {
			return r.ruleRouteLocked(id), "learned", true, nil
		}
	}
	if at, ok := r.unclaimed[host]; ok && r.now().Sub(at) < unclaimedTTL {
		return r.def, "unclaimed", true, nil
	}
	if !register {
		return r.def, "default", false, nil
	}
	ch := make(chan struct{})
	r.waiters[host] = append(r.waiters[host], ch)
	return r.def, "default", false, ch
}

func (r *Router) ruleRouteLocked(id string) string {
	if id == "" {
		return r.def
	}
	if rule, ok := r.byID[id]; ok {
		return rule.Route
	}
	return r.def
}

// matchRuleLocked finds the most specific rule: an exact rule on the host
// itself, else the longest matching "and subdomains" rule.
func (r *Router) matchRuleLocked(host string) *Rule {
	if rule, ok := r.exact[host]; ok {
		return rule
	}
	if _, err := netip.ParseAddr(host); err == nil {
		return r.suffix[host]
	}
	for h := host; h != ""; {
		if rule, ok := r.suffix[h]; ok {
			return rule
		}
		i := strings.IndexByte(h, '.')
		if i < 0 {
			break
		}
		h = h[i+1:]
	}
	return nil
}

func normHost(h string) string {
	h = strings.ToLower(strings.TrimSpace(h))
	h = strings.TrimSuffix(h, ".")
	h = strings.TrimPrefix(h, "[")
	h = strings.TrimSuffix(h, "]")
	return h
}

// isLocal is true for this Mac and the home network (router pages, printers).
func isLocal(host string) bool {
	if host == "localhost" || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local") || !strings.Contains(host, ".") && !strings.Contains(host, ":") {
		return true
	}
	a, err := netip.ParseAddr(host)
	if err != nil {
		return false
	}
	return a.IsLoopback() || a.IsPrivate() || a.IsLinkLocalUnicast()
}
