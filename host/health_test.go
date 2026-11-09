package main

import (
	"testing"
	"time"
)

func TestPingIsTheMiddleReading(t *testing.T) {
	ms := func(n ...int) []time.Duration {
		out := []time.Duration{}
		for _, v := range n {
			out = append(out, time.Duration(v)*time.Millisecond)
		}
		return out
	}
	cases := []struct {
		pings []time.Duration
		want  int
	}{
		{nil, 0},
		{ms(40), 40},
		{ms(40, 900, 42, 41, 39), 41}, // one slow knock doesn't count
		{ms(200, 210), 210},
		{[]time.Duration{300 * time.Microsecond}, 1}, // LAN-fast still reads as measured
	}
	for _, c := range cases {
		if got := pingMs(c.pings); got != c.want {
			t.Errorf("pingMs(%v) = %d, want %d", c.pings, got, c.want)
		}
	}
}

func TestFastestGroupPick(t *testing.T) {
	type m struct {
		state string
		ping  int
	}
	cases := []struct {
		name    string
		members map[string]m
		current string
		want    string
	}{
		{"quickest wins at the start", map[string]m{"A": {"up", 200}, "B": {"up", 40}}, "", "B"},
		{"stays put when the gap is small", map[string]m{"A": {"up", 60}, "B": {"up", 45}}, "A", "A"},
		{"stays put when only the ratio is big", map[string]m{"A": {"up", 30}, "B": {"up", 5}}, "A", "A"},
		{"moves when clearly quicker", map[string]m{"A": {"up", 250}, "B": {"up", 40}}, "A", "B"},
		{"moves off a dead server at once", map[string]m{"A": {"down", 0}, "B": {"up", 300}}, "A", "B"},
		{"a measured server beats an unmeasured one", map[string]m{"A": {"up", 0}, "B": {"up", 300}}, "", "B"},
		{"no readings: list order", map[string]m{"A": {"up", 0}, "B": {"up", 0}}, "", "A"},
		{"current with no reading yet is kept", map[string]m{"A": {"up", 0}, "B": {"up", 20}}, "A", "A"},
		{"nothing up: first still starting", map[string]m{"A": {"down", 0}, "B": {"starting", 0}}, "A", "B"},
		{"nothing usable", map[string]m{"A": {"down", 0}, "B": {"error", 0}}, "A", ""},
		{"current left the group", map[string]m{"A": {"up", 90}, "B": {"up", 80}}, "Z", "B"},
	}
	for _, c := range cases {
		info := func(id string) (string, int) { return c.members[id].state, c.members[id].ping }
		if got := pickFastest([]string{"A", "B"}, info, c.current); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}
