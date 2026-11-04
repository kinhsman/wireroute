// wireroute-relay runs on a WireGuard server (inside the custom wg-easy
// image) and opens connections to websites for WireRoute users. It only
// serves connections that arrive over the WireGuard interface from that
// interface's own network, so it is invisible from the internet.
//
//	WIREROUTE_RELAY=off           turn it off
//	WIREROUTE_RELAY_PORT=51829    port on the VPN address
//	WIREROUTE_RELAY_IFACE=wg0     the WireGuard interface
package main

import (
	"fmt"
	"log"
	"net"
	"net/netip"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/sanglam/wireroute/host/relay"
)

func main() {
	log.SetFlags(0)
	log.SetPrefix("[wireroute-relay] ")
	if strings.EqualFold(os.Getenv("WIREROUTE_RELAY"), "off") {
		log.Print("off (WIREROUTE_RELAY=off)")
		select {} // stay up so the start script doesn't loop
	}
	port := relay.Port
	if v := os.Getenv("WIREROUTE_RELAY_PORT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n < 65536 {
			port = n
		}
	}
	iface := os.Getenv("WIREROUTE_RELAY_IFACE")
	if iface == "" {
		iface = "wg0"
	}

	w := &watcher{iface: iface}
	go w.run()

	// Listen everywhere but serve only connections that came in on the VPN
	// address from the VPN's own network. Binding to the address itself would
	// break each time wg-easy restarts the interface.
	ln, err := net.Listen("tcp", fmt.Sprintf(":%d", port))
	if err != nil {
		log.Fatalf("can't listen on port %d: %v", port, err)
	}
	log.Printf("listening on port %d, serving VPN users on %s", port, iface)
	s := &relay.Server{
		Allowed: w.allowed,
		Dialer:  net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second},
	}
	log.Fatal(s.Serve(ln))
}

// watcher keeps the WireGuard interface's networks current.
type watcher struct {
	iface string
	mu    sync.Mutex
	nets  []netip.Prefix
}

func (w *watcher) run() {
	var last string
	for {
		var nets []netip.Prefix
		if ifc, err := net.InterfaceByName(w.iface); err == nil {
			addrs, _ := ifc.Addrs()
			for _, a := range addrs {
				if p, err := netip.ParsePrefix(a.String()); err == nil {
					nets = append(nets, p)
				}
			}
		}
		w.mu.Lock()
		w.nets = nets
		w.mu.Unlock()
		if s := fmt.Sprint(nets); s != last {
			if len(nets) == 0 {
				log.Printf("waiting for %s", w.iface)
			} else {
				log.Printf("%s is %s", w.iface, s)
			}
			last = s
		}
		time.Sleep(5 * time.Second)
	}
}

func (w *watcher) allowed(remote, local netip.Addr) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	for _, p := range w.nets {
		if p.Addr().Unmap() == local && p.Masked().Contains(remote) {
			return true
		}
	}
	return false
}
