package main

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"sync"
)

// Chrome native messaging: each message is a 4-byte native-endian (little
// endian on every platform we ship) length followed by UTF-8 JSON.
// Chrome caps host-to-browser messages at 1 MiB.
const maxMessageSize = 1 << 20

// Browser-to-host messages can be larger (the config carries every learned
// host), so allow more on the way in.
const maxIncomingSize = 16 << 20

func readMessage(r io.Reader) (*Incoming, error) {
	var sizeBuf [4]byte
	if _, err := io.ReadFull(r, sizeBuf[:]); err != nil {
		return nil, err
	}
	size := binary.LittleEndian.Uint32(sizeBuf[:])
	if size == 0 || size > maxIncomingSize {
		return nil, fmt.Errorf("bad message size %d", size)
	}
	buf := make([]byte, size)
	if _, err := io.ReadFull(r, buf); err != nil {
		return nil, err
	}
	var msg Incoming
	if err := json.Unmarshal(buf, &msg); err != nil {
		return nil, fmt.Errorf("bad JSON: %w", err)
	}
	return &msg, nil
}

// writer serialises writes: replies come from goroutines (checks, tunnel
// events) as well as the main loop.
type writer struct {
	mu sync.Mutex
	w  io.Writer
}

func (w *writer) send(msg Outgoing) {
	payload, err := json.Marshal(msg)
	if err != nil || len(payload) > maxMessageSize {
		logf("dropping outgoing %s message: %v (size %d)", msg.Type, err, len(payload))
		return
	}
	var sizeBuf [4]byte
	binary.LittleEndian.PutUint32(sizeBuf[:], uint32(len(payload)))
	w.mu.Lock()
	defer w.mu.Unlock()
	if _, err := w.w.Write(sizeBuf[:]); err != nil {
		logf("write failed: %v", err)
		return
	}
	if _, err := w.w.Write(payload); err != nil {
		logf("write failed: %v", err)
	}
}
