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
