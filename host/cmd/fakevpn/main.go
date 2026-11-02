// fakevpn runs pretend WireGuard servers for testing WireRoute end to end,
// with no admin rights and nothing touching the Mac's network.
//
// Each server lives inside this process. Through its tunnel, every website
// name resolves to the server itself, and every page says which server
// answered, so a test can tell exactly which way a request went.
//
//	go run ./cmd/fakevpn -dir /tmp/fake A B
//
// writes /tmp/fake/A.conf and /tmp/fake/B.conf (client configs to import)
// and runs until killed.
package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/netip"
	"os"
	"os/signal"
	"path/filepath"
	"strings"

	"golang.org/x/crypto/curve25519"
	"golang.org/x/net/dns/dnsmessage"
	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun/netstack"
)

var serverIP = netip.MustParseAddr("10.9.0.1")

func key() (priv, pub []byte) {
	priv = make([]byte, 32)
	if _, err := rand.Read(priv); err != nil {
		log.Fatal(err)
	}
	priv[0] &= 248
	priv[31] = (priv[31] & 127) | 64
	pub, err := curve25519.X25519(priv, curve25519.Basepoint)
	if err != nil {
		log.Fatal(err)
	}
	return priv, pub
}

func main() {
	dir := flag.String("dir", ".", "where to write client .conf files")
	flag.Parse()
	names := flag.Args()
	if len(names) == 0 {
		names = []string{"A"}
	}
	for _, name := range names {
		run(name, *dir)
	}
	fmt.Println("ready")
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, os.Interrupt)
	<-ch
}

func run(name, dir string) {
	sPriv, sPub := key()
	cPriv, cPub := key()

	udp, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		log.Fatal(err)
	}
	port := udp.LocalAddr().(*net.UDPAddr).Port
	udp.Close()

	tunDev, tnet, err := netstack.CreateNetTUN([]netip.Addr{serverIP}, nil, 1420)
	if err != nil {
		log.Fatal(err)
	}
	dev := device.NewDevice(tunDev, conn.NewStdNetBind(), device.NewLogger(device.LogLevelError, name+": "))
	cfg := fmt.Sprintf("private_key=%s\nlisten_port=%d\npublic_key=%s\nallowed_ip=10.9.0.2/32\n",
		hex.EncodeToString(sPriv), port, hex.EncodeToString(cPub))
	if err := dev.IpcSet(cfg); err != nil {
		log.Fatal(err)
	}
	if err := dev.Up(); err != nil {
		log.Fatal(err)
	}

	// DNS: every name is this server.
	dnsConn, err := tnet.ListenUDPAddrPort(netip.AddrPortFrom(serverIP, 53))
	if err != nil {
		log.Fatal(err)
	}
	go serveDNS(dnsConn)

	ln, err := tnet.ListenTCPAddrPort(netip.AddrPortFrom(serverIP, 80))
	if err != nil {
		log.Fatal(err)
	}
	go http.Serve(ln, handler(name))

	conf := fmt.Sprintf(`[Interface]
PrivateKey = %s
Address = 10.9.0.2/32
DNS = 10.9.0.1

[Peer]
PublicKey = %s
Endpoint = 127.0.0.1:%d
AllowedIPs = 0.0.0.0/0
`, base64.StdEncoding.EncodeToString(cPriv), base64.StdEncoding.EncodeToString(sPub), port)
	path := filepath.Join(dir, name+".conf")
	if err := os.WriteFile(path, []byte(conf), 0o600); err != nil {
		log.Fatal(err)
	}
	fmt.Printf("server %s on 127.0.0.1:%d, client config %s\n", name, port, path)
}

// handler: /whoami answers the server name; a page whose host starts with
// "site" loads a hidden address the way a video site loads its CDN.
func handler(name string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host := r.Host
		if h, _, err := net.SplitHostPort(host); err == nil {
			host = h
		}
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Cache-Control", "no-store")
		q := r.URL.Query()
		switch {
		case r.URL.Path == "/whoami":
			fmt.Fprint(w, name)
		case strings.HasPrefix(host, "search"):
			// A search results page: preconnects and loads its own assets, and
			// links to a result.
			to := q.Get("to")
			if to == "" {
				to = "http://site-a.test/"
			}
			w.Header().Set("Content-Type", "text/html")
			fmt.Fprintf(w, `<!doctype html><title>search %s</title>
<link rel="preconnect" href="http://search-assets.test">
<img src="http://search-assets.test/logo.png" alt="">
<a id="result" href="%s">result</a>`, name, to)
		case strings.HasPrefix(host, "widget"):
			// An embedded player from another company, with its own CDN.
			w.Header().Set("Content-Type", "text/html")
			fmt.Fprintf(w, `<!doctype html><title>widget</title><script>
fetch("http://widget-cdn.test/whoami").then(r => r.text()).then(t => parent.postMessage("widget-cdn:" + t, "*"));
</script>`)
		case strings.HasPrefix(host, "site"):
			cdn := r.URL.Query().Get("cdn")
			if cdn == "" {
				cdn = "hidden-cdn.test"
			}
			frame := ""
			if f := q.Get("frame"); f != "" {
				frame = fmt.Sprintf(`<iframe src="http://%s/frame"></iframe>`, f)
			}
			w.Header().Set("Content-Type", "text/html")
			fmt.Fprintf(w, `<!doctype html><title>loading</title><h1>page from %s</h1>%s
<script>
addEventListener("message", (e) => { document.body.dataset.widget = e.data; });
fetch("http://%s/whoami").then(r => r.text()).then(t => { document.title = "page:%s cdn:" + t; })
  .catch(e => { document.title = "page:%s cdn:error"; });
window.later = (h) => fetch("http://" + h + "/whoami").then(r => r.text());
</script>`, name, frame, cdn, name, name)
		default:
			fmt.Fprintf(w, "via %s for %s", name, host)
		}
	})
}

func serveDNS(c net.PacketConn) {
	buf := make([]byte, 1500)
	for {
		n, addr, err := c.ReadFrom(buf)
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
		b := dnsmessage.NewBuilder(nil, dnsmessage.Header{ID: h.ID, Response: true, Authoritative: true})
		b.EnableCompression()
		_ = b.StartQuestions()
		_ = b.Question(q)
		_ = b.StartAnswers()
		if q.Type == dnsmessage.TypeA {
			_ = b.AResource(dnsmessage.ResourceHeader{Name: q.Name, Class: dnsmessage.ClassINET, TTL: 60},
				dnsmessage.AResource{A: serverIP.As4()})
		}
		out, err := b.Finish()
		if err == nil {
			_, _ = c.WriteTo(out, addr)
		}
	}
}
