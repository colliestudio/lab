package main

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Sidecar runs the canvas service (desktop/sidecar, compiled to canvas-bridge with bun) and talks to
// it over JSON lines on stdin/stdout. It restarts the service if it dies (same port and token, so
// open windows reconnect on their own) and re-opens the boards.

type Sidecar struct {
	cmdline []string
	home    string
	token   string
	logw    io.Writer

	mu      sync.Mutex
	stdin   io.WriteCloser
	proc    *exec.Cmd
	port    int
	nextID  int
	pending map[int]chan map[string]any
	ready   chan struct{}
	stopped bool
	exited  chan struct{}

	onCall func(op string, msg map[string]any) (map[string]any, error) // service → shell
	boards func() []string                                            // files to re-open after a restart
}

func newSidecar(home string, logw io.Writer) *Sidecar {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return &Sidecar{cmdline: sidecarCommand(), home: home, token: hex.EncodeToString(b), logw: logw, pending: map[int]chan map[string]any{}, ready: make(chan struct{})}
}

// sidecarCommand: $CANVAS_SIDECAR (dev: "npx tsx desktop/sidecar/main.ts"), else canvas-bridge next to the executable.
func sidecarCommand() []string {
	if s := os.Getenv("CANVAS_SIDECAR"); s != "" {
		return strings.Fields(s)
	}
	exe, _ := os.Executable()
	return []string{filepath.Join(filepath.Dir(exe), "canvas-bridge")}
}

func (s *Sidecar) Start() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	cmd := exec.Command(s.cmdline[0], s.cmdline[1:]...)
	cmd.Env = append(os.Environ(), "CANVAS_HOME="+s.home, "CANVAS_TOKEN="+s.token)
	if s.port != 0 {
		cmd.Env = append(cmd.Env, fmt.Sprintf("CANVAS_PORT=%d", s.port))
	}
	cmd.Stderr = s.logw
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	t0 := time.Now()
	if err := cmd.Start(); err != nil {
		return err
	}
	s.proc, s.stdin = cmd, stdin
	s.exited = make(chan struct{})
	exited := s.exited
	log.Printf("sidecar: started pid %d (%s)", cmd.Process.Pid, strings.Join(s.cmdline, " "))
	go s.read(stdout, t0)
	go s.wait(cmd, exited)
	return nil
}

func (s *Sidecar) read(r io.Reader, t0 time.Time) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 1<<20), 64<<20)
	for sc.Scan() {
		var m map[string]any
		if err := json.Unmarshal(sc.Bytes(), &m); err != nil {
			log.Printf("sidecar: %s", sc.Text())
			continue
		}
		switch m["t"] {
		case "event":
			if m["name"] == "ready" {
				s.mu.Lock()
				s.port = int(m["port"].(float64))
				first := s.ready
				s.mu.Unlock()
				log.Printf("sidecar: ready on port %d after %d ms", s.port, time.Since(t0).Milliseconds())
				select {
				case <-first:
				default:
					close(first)
				}
			}
		case "reply":
			id := int(m["id"].(float64))
			s.mu.Lock()
			ch := s.pending[id]
			delete(s.pending, id)
			s.mu.Unlock()
			if ch != nil {
				ch <- m
			}
		case "call":
			go func(m map[string]any) {
				op, _ := m["op"].(string)
				res, err := s.onCall(op, m)
				out := map[string]any{"t": "reply", "id": m["id"], "ok": err == nil}
				if err != nil {
					out["error"] = err.Error()
				}
				for k, v := range res {
					out[k] = v
				}
				s.send(out)
			}(m)
		}
	}
}

func (s *Sidecar) wait(cmd *exec.Cmd, exited chan struct{}) {
	err := cmd.Wait()
	close(exited)
	s.mu.Lock()
	stopped := s.stopped
	for id, ch := range s.pending {
		ch <- map[string]any{"ok": false, "error": "service restarted"}
		delete(s.pending, id)
	}
	s.mu.Unlock()
	if stopped {
		return
	}
	log.Printf("sidecar: exited (%v); restarting in 500 ms", err)
	time.Sleep(500 * time.Millisecond)
	if err := s.Start(); err != nil {
		log.Printf("sidecar: restart failed: %v", err)
		return
	}
	go func() {
		for _, f := range s.boards() {
			if _, err := s.Call("open", map[string]any{"path": f}); err != nil {
				log.Printf("sidecar: re-open %s: %v", f, err)
			}
		}
	}()
}

func (s *Sidecar) send(m map[string]any) error {
	b, _ := json.Marshal(m)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stdin == nil {
		return errors.New("service not running")
	}
	_, err := s.stdin.Write(append(b, '\n'))
	return err
}

// Call sends an op to the service and waits for its reply.
func (s *Sidecar) Call(op string, args map[string]any) (map[string]any, error) {
	<-s.ready
	s.mu.Lock()
	s.nextID++
	id := s.nextID
	ch := make(chan map[string]any, 1)
	s.pending[id] = ch
	s.mu.Unlock()
	m := map[string]any{"t": "call", "id": id, "op": op}
	for k, v := range args {
		m[k] = v
	}
	if err := s.send(m); err != nil {
		return nil, err
	}
	select {
	case r := <-ch:
		if ok, _ := r["ok"].(bool); !ok {
			return nil, fmt.Errorf("%s: %v", op, r["error"])
		}
		return r, nil
	case <-time.After(15 * time.Second):
		return nil, fmt.Errorf("%s: service did not answer", op)
	}
}

func (s *Sidecar) Base() string {
	<-s.ready
	return fmt.Sprintf("127.0.0.1:%d/%s", s.port, s.token)
}

func (s *Sidecar) Pid() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.proc == nil || s.proc.Process == nil {
		return 0
	}
	return s.proc.Process.Pid
}

// Stop closes stdin (the service saves every board and exits), then waits a little.
func (s *Sidecar) Stop() {
	s.mu.Lock()
	s.stopped = true
	proc, exited := s.proc, s.exited
	if s.stdin != nil {
		s.stdin.Close()
	}
	s.mu.Unlock()
	if proc == nil || proc.Process == nil {
		return
	}
	select {
	case <-exited:
	case <-time.After(3 * time.Second):
		proc.Process.Kill()
	}
}
