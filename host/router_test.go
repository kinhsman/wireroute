package main

import (
	"context"
	"testing"
	"time"
)

func testRouter(c *Config) *Router {
	r := NewRouter()
	if c.HoldMs == 0 {
		c.HoldMs = 50
	}
	r.SetConfig(c)
	return r
}

func TestRuleMatching(t *testing.T) {
	r := testRouter(&Config{
		DefaultRoute: "direct",
		Rules: []Rule{
			{ID: "cnn", Pattern: "cnn.com", Route: "us"},
			{ID: "ed", Pattern: "edition.cnn.com", Route: "uk"},
			{ID: "ex", Pattern: "exact.example.com", Exact: true, Route: "vn"},
			{ID: "tv", Pattern: "TV360.vn.", Route: "vn"},
		},
	})
	cases := map[string]string{
		"cnn.com":               "us",
		"www.cnn.com":           "us",
		"a.b.cnn.com":           "us",
		"edition.cnn.com":       "uk",
		"live.edition.cnn.com":  "uk",
		"notcnn.com":            "direct",
		"exact.example.com":     "vn",
		"sub.exact.example.com": "direct",
		"tv360.vn":              "vn",
		"WWW.TV360.VN":          "vn",
		"cnn.com.evil.example":  "direct",
	}
	for host, want := range cases {
		// Mark as seen so Decide doesn't wait on unknown hosts.
		r.Hint(host, "")
		if got := r.Peek(host); got != want {
			t.Errorf("%s: got %s, want %s", host, got, want)
		}
	}
}

func TestHintFollowsSite(t *testing.T) {
	r := testRouter(&Config{
		DefaultRoute: "direct",
		Rules:        []Rule{{ID: "tv", Pattern: "tv360.vn", Route: "vn"}},
	})
	r.Hint("video.viettel.vn", "tv")
	if got := r.Peek("video.viettel.vn"); got != "vn" {
		t.Fatalf("hinted host: got %s, want vn", got)
	}
	// An unruled tab touching the same address must not steal it.
	r.Hint("video.viettel.vn", "")
	if got := r.Peek("video.viettel.vn"); got != "vn" {
		t.Fatalf("after unruled hint: got %s, want vn", got)
	}
}

func TestFirstClaimWins(t *testing.T) {
	r := testRouter(&Config{
		DefaultRoute: "direct",
		Rules: []Rule{
			{ID: "a", Pattern: "site-a.example", Route: "us"},
			{ID: "b", Pattern: "site-b.example", Route: "vn"},
		},
	})
	r.Hint("shared-cdn.example", "a")
	r.Hint("shared-cdn.example", "b")
	if route, why, rule := r.Explain("shared-cdn.example"); route != "us" || why != "hint" || rule != "a" {
		t.Fatalf("got %s/%s/%s, want us/hint/a", route, why, rule)
	}
	// Once the first claim goes stale, the other site may take it.
	r.now = func() time.Time { return time.Now().Add(hintTTL + time.Second) }
	r.Hint("shared-cdn.example", "b")
	if route, _, rule := r.Explain("shared-cdn.example"); route != "vn" || rule != "b" {
		t.Fatalf("after expiry got %s/%s, want vn/b", route, rule)
	}
}

// Picking a server for a site that was just loaded: its hidden addresses
// were hinted "no rule" a moment ago, then the extension tags them to the new
// rule. They must switch at once, not after the old hint expires.
func TestNewRuleBeatsOldHint(t *testing.T) {
	r := testRouter(&Config{DefaultRoute: "b"})
	r.Hint("cdn.site-d.example", "")
	if got := r.Peek("cdn.site-d.example"); got != "b" {
		t.Fatalf("before: got %s, want b", got)
	}
	r.SetConfig(&Config{
		DefaultRoute: "b",
		Rules:        []Rule{{ID: "d", Pattern: "site-d.example", Route: "a"}},
		Learned:      map[string]string{"cdn.site-d.example": "d"},
	})
	if got := r.Peek("cdn.site-d.example"); got != "a" {
		t.Fatalf("after picking a server: got %s, want a", got)
	}
}

func TestLearnedSurvivesConfig(t *testing.T) {
	r := testRouter(&Config{
		DefaultRoute: "direct",
		Rules:        []Rule{{ID: "tv", Pattern: "tv360.vn", Route: "vn"}},
		Learned:      map[string]string{"video.viettel.vn": "tv", "gone.example": "deleted-rule"},
	})
	if got := r.Peek("video.viettel.vn"); got != "vn" {
		t.Fatalf("learned: got %s, want vn", got)
	}
	if got := r.Peek("gone.example"); got != "direct" {
		t.Fatalf("learned for deleted rule: got %s, want direct", got)
	}
}

func TestExplicitRuleBeatsHint(t *testing.T) {
	r := testRouter(&Config{
		DefaultRoute: "direct",
		Rules: []Rule{
			{ID: "cnn", Pattern: "cnn.com", Route: "us"},
			{ID: "yt", Pattern: "youtube.com", Route: "vn"},
		},
	})
	// cnn.com embeds a YouTube video: youtube's own rule still wins.
	r.Hint("www.youtube.com", "cnn")
	if got := r.Peek("www.youtube.com"); got != "vn" {
		t.Fatalf("got %s, want vn", got)
	}
}

func TestDecideWaitsForHint(t *testing.T) {
	r := testRouter(&Config{
		DefaultRoute: "direct",
		HoldMs:       2000,
		Rules:        []Rule{{ID: "tv", Pattern: "tv360.vn", Route: "vn"}},
	})
	go func() {
		time.Sleep(30 * time.Millisecond)
		r.Hint("cdn.example.net", "tv")
	}()
	start := time.Now()
	got := r.Decide(context.Background(), "cdn.example.net")
	if got != "vn" {
		t.Fatalf("got %s, want vn", got)
	}
	if time.Since(start) > time.Second {
		t.Fatalf("waited the full hold instead of waking on the hint")
	}
}

func TestDecideTimesOutToDefault(t *testing.T) {
	r := testRouter(&Config{DefaultRoute: "home", HoldMs: 60})
	start := time.Now()
	if got := r.Decide(context.Background(), "nobody.example"); got != "home" {
		t.Fatalf("got %s, want home", got)
	}
	if time.Since(start) < 50*time.Millisecond {
		t.Fatalf("did not wait for a hint")
	}
	// Second connection to the same host doesn't wait again.
	start = time.Now()
	r.Decide(context.Background(), "nobody.example")
	if time.Since(start) > 30*time.Millisecond {
		t.Fatalf("waited twice for the same host")
	}
}

func TestLocalStaysDirect(t *testing.T) {
	r := testRouter(&Config{DefaultRoute: "home", LanDirect: true})
	for _, h := range []string{"localhost", "192.168.1.1", "10.0.0.5", "printer.local", "router", "[::1]"} {
		if got := r.Peek(h); got != "direct" {
			t.Errorf("%s: got %s, want direct", h, got)
		}
	}
	if got := r.Peek("8.8.8.8"); got != "home" {
		t.Errorf("public IP: got %s, want home", got)
	}
}
