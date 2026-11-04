package main

// Version is reported to the extension on hello so the UI can show it and
// warn when the extension and helper drift apart.
const Version = "1.3.1"

// Route values. Anything else is a server ID.
const (
	RouteDirect = "direct"
)

// ServerConf is one WireGuard server ("peer") as the extension stores it.
// Keys are base64, exactly as they appear in a .conf file.
type ServerConf struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	PrivateKey   string   `json:"privateKey"`
	Addresses    []string `json:"addresses"`
	DNS          []string `json:"dns"`
	MTU          int      `json:"mtu"`
	PublicKey    string   `json:"publicKey"`
	PresharedKey string   `json:"presharedKey"`
	Endpoint     string   `json:"endpoint"`
	AllowedIPs   []string `json:"allowedIPs"`
	Keepalive    int      `json:"keepalive"`
}

// Rule sends a site (and, unless Exact, all its subdomains) through Route.
type Rule struct {
	ID      string `json:"id"`
	Pattern string `json:"pattern"`
	Exact   bool   `json:"exact"`
	Route   string `json:"route"`
}

// Group is a set of servers a site can use; connections take the first one
// that's up, so if it dies the site moves to the next.
type Group struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Members []string `json:"members"`
}

// Config is the whole routing picture. The extension sends it on every change.
type Config struct {
	Servers      []ServerConf      `json:"servers"`
	Groups       []Group           `json:"groups"`
	Rules        []Rule            `json:"rules"`
	Learned      map[string]string `json:"learned"` // host -> rule ID
	DefaultRoute string            `json:"defaultRoute"`
	KillSwitch   bool              `json:"killSwitch"`
	LanDirect    bool              `json:"lanDirect"`
	HoldMs       int               `json:"holdMs"`
}

// Incoming is any message from the extension.
type Incoming struct {
	ID     int      `json:"id,omitempty"`
	Cmd    string   `json:"cmd"`
	Port   int      `json:"port,omitempty"`
	Config *Config  `json:"config,omitempty"`
	Host   string   `json:"host,omitempty"`
	Rule   string   `json:"rule,omitempty"`
	Server string   `json:"server,omitempty"`
	Hosts  []string `json:"hosts,omitempty"`
}

// Explained is how one host is routed right now, for the popup.
type Explained struct {
	Host  string `json:"host"`
	Route string `json:"route"`
	Why   string `json:"why"`
	Rule  string `json:"rule,omitempty"`
	Via   string `json:"via,omitempty"` // server a group would use right now
}

// TunnelStatus is what the UI shows for one server.
type TunnelStatus struct {
	Server        string `json:"server"`
	State         string `json:"state"` // starting | up | down | error
	Error         string `json:"error,omitempty"`
	LastHandshake int64  `json:"lastHandshake,omitempty"` // unix seconds
	RxBytes       int64  `json:"rxBytes"`
	TxBytes       int64  `json:"txBytes"`
	Relay         bool   `json:"relay,omitempty"` // connections go through the server's relay
}

// Outgoing is any message to the extension. ID echoes the request it answers;
// events (type "tunnel") carry no ID.
type Outgoing struct {
	ID      int            `json:"id,omitempty"`
	Type    string         `json:"type"`
	Error   string         `json:"error,omitempty"`
	Version string         `json:"version,omitempty"`
	Port    int            `json:"port,omitempty"`
	Tunnels []TunnelStatus `json:"tunnels,omitempty"`
	Tunnel  *TunnelStatus  `json:"tunnel,omitempty"`
	IP      string         `json:"ip,omitempty"`
	Loc     string         `json:"loc,omitempty"`
	// DirectIP is your own address, so the UI can warn when a server comes
	// out onto the internet as you.
	DirectIP string      `json:"directIP,omitempty"`
	Recent   []Decision  `json:"recent,omitempty"`
	Routes   []Explained `json:"routes,omitempty"`
}
