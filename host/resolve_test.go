package main

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/netip"
	"strings"
	"testing"
	"time"

	"golang.org/x/net/dns/dnsmessage"
	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun/netstack"
)

// A server shaped like lambut: it hands out an IPv6 address but can't reach
// IPv6 sites, and the first DNS server in the config never answers. Before
// the fix every connection waited 5s on the dead DNS server, then tried the
// dead IPv6 address first, often until timeout.
//
// The server lives at 10.9.0.1 and fd00::1. Its DNS (10.9.0.1:53) answers:
//
//	site.test     A 10.9.0.1, AAAA fd00::99 (nothing there: packets vanish)
//	v6only.test   AAAA fd00::1 (works)
//	anything else NXDOMAIN
func lambutLikeServer(t *testing.T, clientPub []byte) (pub []byte, port int) {
	priv, pub := genKey(t)
	port = freeUDPPort(t)
	v4, v6 := netip.MustParseAddr("10.9.0.1"), netip.MustParseAddr("fd00::1")
	tunDev, tnet, err := netstack.CreateNetTUN([]netip.Addr{v4, v6}, nil, 1420)
	if err != nil {
		t.Fatal(err)
	}
	dev := device.NewDevice(tunDev, conn.NewStdNetBind(), device.NewLogger(device.LogLevelSilent, ""))
	cfg := fmt.Sprintf("private_key=%s\nlisten_port=%d\npublic_key=%s\nallowed_ip=10.9.0.2/32\nallowed_ip=fd00::2/128\n",
		hex.EncodeToString(priv), port, hex.EncodeToString(clientPub))
	if err := dev.IpcSet(cfg); err != nil {
		t.Fatal(err)
	}
	if err := dev.Up(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(dev.Close)

	for _, ip := range []netip.Addr{v4, v6} {
		ln, err := tnet.ListenTCPAddrPort(netip.AddrPortFrom(ip, 80))
		if err != nil {
			t.Fatal(err)
		}
		srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			fmt.Fprint(w, "hello from the server")
		})}
		go srv.Serve(ln)
		t.Cleanup(func() { srv.Close() })
	}

	udp, err := tnet.ListenUDPAddrPort(netip.AddrPortFrom(v4, 53))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { udp.Close() })
	go func() {
		buf := make([]byte, 1500)
		for {
			n, from, err := udp.ReadFrom(buf)
			if err != nil {
				return
			}
			var p dnsmessage.Parser
			h, err := p.Start(buf[:n])
			if err != nil {
				continue
			}
			q, err := p.Question()
			if err != nil {
				continue
			}
			resp := dnsmessage.Message{
				Header:    dnsmessage.Header{ID: h.ID, Response: true, RecursionAvailable: true},
				Questions: []dnsmessage.Question{q},
			}
			rh := dnsmessage.ResourceHeader{Name: q.Name, Class: dnsmessage.ClassINET, TTL: 60}
			switch name := q.Name.String(); {
			case name == "site.test." && q.Type == dnsmessage.TypeA:
				resp.Answers = append(resp.Answers, dnsmessage.Resource{Header: rh, Body: &dnsmessage.AResource{A: v4.As4()}})
			case name == "site.test." && q.Type == dnsmessage.TypeAAAA:
				resp.Answers = append(resp.Answers, dnsmessage.Resource{Header: rh, Body: &dnsmessage.AAAAResource{AAAA: netip.MustParseAddr("fd00::99").As16()}})
			case name == "v6only.test." && q.Type == dnsmessage.TypeAAAA:
				resp.Answers = append(resp.Answers, dnsmessage.Resource{Header: rh, Body: &dnsmessage.AAAAResource{AAAA: v6.As16()}})
			case name == "v6only.test.":
				// no IPv4 address: an empty answer
			default:
				resp.RCode = dnsmessage.RCodeNameError
			}
			out, err := resp.Pack()
			if err != nil {
				continue
			}
			udp.WriteTo(out, from)
		}
	}()
	return pub, port
}

func lambutLikeTunnel(t *testing.T) *Tunnel {
	clientPriv, clientPub := genKey(t)
	serverPub, port := lambutLikeServer(t, clientPub)
	c := ServerConf{
		ID:         "L",
		Name:       "L",
		PrivateKey: base64.StdEncoding.EncodeToString(clientPriv),
		Addresses:  []string{"10.9.0.2/32", "fd00::2/128"},
		DNS:        []string{"10.9.0.53", "10.9.0.1"}, // the first one never answers
		PublicKey:  base64.StdEncoding.EncodeToString(serverPub),
		Endpoint:   fmt.Sprintf("127.0.0.1:%d", port),
		AllowedIPs: []string{"10.9.0.0/24", "fd00::/64"},
	}
	tun, err := startTunnel(c, func(TunnelStatus) {})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(tun.Close)
	return tun
}

func get(t *testing.T, tun *Tunnel, host string) (string, time.Duration, error) {
	start := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, err := tun.Dial(ctx, host+":80")
	if err != nil {
		return "", time.Since(start), err
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(5 * time.Second))
	fmt.Fprintf(c, "GET / HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n\r\n", host)
	b, _ := io.ReadAll(c)
	return string(b), time.Since(start), nil
}

func TestSitesOpenFastThroughAServerWithoutIPv6(t *testing.T) {
	tun := lambutLikeTunnel(t)
	for i := range 5 {
		body, took, err := get(t, tun, "site.test")
		if err != nil {
			t.Fatalf("try %d: %v (after %s)", i, err, took)
		}
		if !strings.Contains(body, "hello from the server") {
			t.Fatalf("try %d: unexpected answer %q", i, body)
		}
		// Generous for a slow test machine; the old way took 5s or more.
		if took > 2*time.Second {
			t.Fatalf("try %d took %s", i, took)
		}
		t.Logf("try %d: %s", i, took)
	}
}

func TestIPv6OnlySitesStillWork(t *testing.T) {
	tun := lambutLikeTunnel(t)
	body, took, err := get(t, tun, "v6only.test")
	if err != nil {
		t.Fatalf("%v (after %s)", err, took)
	}
	if !strings.Contains(body, "hello from the server") {
		t.Fatalf("unexpected answer %q", body)
	}
	if took > 3*time.Second {
		t.Fatalf("took %s", took)
	}
}

func TestUnknownSiteFailsQuickly(t *testing.T) {
	tun := lambutLikeTunnel(t)
	_, took, err := get(t, tun, "nope.test")
	if err == nil {
		t.Fatal("expected an error")
	}
	if took > 3*time.Second {
		t.Fatalf("took %s to fail", took)
	}
}
