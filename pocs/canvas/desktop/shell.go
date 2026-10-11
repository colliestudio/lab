package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

type boardWin struct {
	id, file string
	win      *application.WebviewWindow
}

// eye: a hidden window rendering one board for one agent seat, with its own camera.
type eye struct {
	mu   sync.Mutex
	win  *application.WebviewWindow
	w, h int
	seen bool // camera set at least once
}

type Shell struct {
	app  *application.App
	side *Sidecar
	home string

	mu         sync.Mutex
	windows    map[string]*boardWin // board id → window
	eyes       map[string]*eye      // board id|seat id → eye
	recent     []string
	recentMenu *application.Menu
	menu       *application.Menu
	started    chan struct{}
	firstOpen  bool
	openMu     sync.Mutex // one open at a time (AppKit also delivers argv files as open events)
}

func newShell(home string, logw io.Writer) *Shell {
	sh := &Shell{home: home, windows: map[string]*boardWin{}, eyes: map[string]*eye{}, started: make(chan struct{})}
	sh.side = newSidecar(home, logw)
	sh.side.onCall = sh.onServiceCall
	sh.side.boards = func() []string {
		sh.mu.Lock()
		defer sh.mu.Unlock()
		var fs []string
		for _, w := range sh.windows {
			fs = append(fs, w.file)
		}
		return fs
	}
	readJSON(filepath.Join(home, "recent.json"), &sh.recent)
	return sh
}

func (sh *Shell) onStarted(args []string) {
	close(sh.started)
	for _, f := range args {
		sh.requestOpen(f)
	}
	// Nothing asked for (no args, no Finder open event within a moment): reopen the last file.
	time.Sleep(400 * time.Millisecond)
	sh.mu.Lock()
	opened := sh.firstOpen
	sh.mu.Unlock()
	if !opened {
		sh.reopen()
	}
}

func (sh *Shell) reopen() {
	sh.mu.Lock()
	n := len(sh.windows)
	var last string
	for _, f := range sh.recent {
		if _, err := os.Stat(f); err == nil {
			last = f
			break
		}
	}
	sh.mu.Unlock()
	if n > 0 {
		return
	}
	if last == "" {
		last = filepath.Join(sh.home, "Scratch.canvas")
	}
	sh.requestOpen(last)
}

func (sh *Shell) requestOpen(path string) {
	sh.mu.Lock()
	sh.firstOpen = true
	sh.mu.Unlock()
	go func() {
		<-sh.started
		if _, err := sh.openFile(path); err != nil {
			log.Printf("open %s: %v", path, err)
			sh.app.Dialog.Error().SetTitle("Can't open").SetMessage(err.Error()).Show()
		}
	}()
}

// openFile: the service opens (or already has) the board; one window per board.
func (sh *Shell) openFile(path string) (string, error) {
	sh.openMu.Lock()
	defer sh.openMu.Unlock()
	t0 := time.Now()
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	r, err := sh.side.Call("open", map[string]any{"path": abs})
	if err != nil {
		return "", err
	}
	info, _ := r["board"].(map[string]any)
	id, _ := info["board"].(string)
	file, _ := info["file"].(string)
	name, _ := info["name"].(string)
	sh.addRecent(file)

	sh.mu.Lock()
	if bw, ok := sh.windows[id]; ok {
		sh.mu.Unlock()
		bw.win.Show()
		bw.win.Focus()
		return id, nil
	}
	sh.mu.Unlock()

	url := fmt.Sprintf("/?bridge=ws://%s/b/%s", sh.side.Base(), id)
	win := sh.app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:             "board-" + id,
		Title:            name,
		Width:            1280,
		Height:           820,
		URL:              url,
		BackgroundColour: application.NewRGB(0x11, 0x22, 0x33),
	})
	bw := &boardWin{id: id, file: file, win: win}
	sh.mu.Lock()
	sh.windows[id] = bw
	sh.mu.Unlock()
	win.OnWindowEvent(events.Common.WindowClosing, func(*application.WindowEvent) {
		sh.mu.Lock()
		delete(sh.windows, id)
		sh.mu.Unlock()
		log.Printf("window closed: %s (board stays open in the service for agents)", name)
	})
	go sh.watchVisible(bw, name, t0)
	return id, nil
}

// watchVisible logs when the board is synced and drawn (cold start / open latency).
func (sh *Shell) watchVisible(bw *boardWin, name string, t0 time.Time) {
	nw := waitNative(bw.win, 5*time.Second)
	if nw == nil {
		return
	}
	setRepresentedFile(nw, bw.file)
	body := `if (!window.room || !window.room.synced) return null;
		await window.room.synced;
		await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
		return document.querySelectorAll('[data-node-id]').length;`
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		out, err := evalJS(nw, body, 3*time.Second)
		if err == nil && out != "null" && out != "" {
			log.Printf("board visible: %s nodes=%s open→visible %d ms, process start→visible %d ms (%s)",
				name, out, time.Since(t0).Milliseconds(), time.Since(processStart).Milliseconds(), windowState(nw))
			return
		}
		time.Sleep(30 * time.Millisecond)
	}
	log.Printf("board %s: not visible after 15 s", name)
}

func waitNative(w *application.WebviewWindow, d time.Duration) unsafe.Pointer {
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if p := w.NativeWindow(); p != nil {
			return p
		}
		time.Sleep(10 * time.Millisecond)
	}
	return nil
}

// ---------------------------------------------------------------- calls from the service

func (sh *Shell) onServiceCall(op string, m map[string]any) (map[string]any, error) {
	switch op {
	case "show":
		file, _ := m["file"].(string)
		_, err := sh.openFile(file)
		return nil, err
	case "screenshot":
		return sh.screenshot(m)
	}
	return nil, fmt.Errorf("unknown op %q", op)
}

func (sh *Shell) screenshot(m map[string]any) (map[string]any, error) {
	t0 := time.Now()
	board, _ := m["board"].(string)
	ws, _ := m["ws"].(string)
	seat, _ := m["seat"].(map[string]any)
	seatID, _ := seat["id"].(string)
	w, h := intOr(m["width"], 1000), intOr(m["height"], 750)
	key := board + "|" + seatID

	sh.mu.Lock()
	e := sh.eyes[key]
	if e == nil {
		e = &eye{}
		sh.eyes[key] = e
	}
	sh.mu.Unlock()
	e.mu.Lock()
	defer e.mu.Unlock()

	if e.win == nil {
		e.win = sh.app.Window.NewWithOptions(application.WebviewWindowOptions{
			Name:   "eye-" + key,
			Title:  fmt.Sprintf("eye: %v", seat["name"]),
			Width:  w,
			Height: h,
			URL:    fmt.Sprintf("/?bridge=%s&eye=%s", ws, seatID),
			Hidden: os.Getenv("CANVAS_EYES_VISIBLE") == "",
			// off-screen if made visible for debugging, so it never covers people's windows
			InitialPosition: application.WindowXY,
			X:               -4000,
			Y:               -4000,
		})
		e.w, e.h = w, h
		log.Printf("eye: created hidden window for %v on %s", seat["name"], board)
	} else if e.w != w || e.h != h {
		e.win.SetSize(w, h)
		e.w, e.h = w, h
		e.seen = false
	}
	nw := waitNative(e.win, 5*time.Second)
	if nw == nil {
		return nil, errors.New("eye window did not come up")
	}
	ready := false
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(25 * time.Millisecond) {
		if out, err := evalJS(nw, `return !!(window.eye && window.eye.ready)`, 2*time.Second); err == nil && out == "true" {
			ready = true
			break
		}
	}
	if !ready {
		return nil, fmt.Errorf("eye window not ready (%s)", windowState(nw))
	}
	tReady := time.Since(t0)

	cam := m["camera"]
	camJS := ""
	switch c := cam.(type) {
	case map[string]any:
		camJS = fmt.Sprintf(`const r = app.view.root, z = %v; app.viewport.set(r.clientWidth / 2 - %v * z, r.clientHeight / 2 - %v * z, z);`, c["zoom"], c["x"], c["y"])
	case string:
		if c == "fit" || (c == "keep" && !e.seen) {
			camJS = `app.view.fit();`
		}
	default:
		if !e.seen {
			camJS = `app.view.fit();`
		}
	}
	e.seen = true
	labels := m["labels"] == true
	labelJS := `document.querySelectorAll('.eye-label').forEach((x) => x.remove());`
	if labels {
		labelJS += `for (const el of document.querySelectorAll('[data-node-id]')) {
			const l = document.createElement('div'); l.className = 'eye-label'; l.textContent = el.dataset.nodeId;
			l.style.cssText = 'position:absolute;left:0;top:-18px;font:11px/16px ui-monospace,monospace;background:#000c;color:#fff;padding:0 4px;border-radius:3px;z-index:99;pointer-events:none;transform-origin:0 100%';
			l.style.transform = 'scale(' + (1 / app.viewport.zoom) + ')';
			el.appendChild(l);
		}`
	}
	// rAF can be throttled in a hidden window: race it with a timeout
	settle := `await new Promise((res) => { let done = false; const f = () => { if (!done) { done = true; res(); } };
		requestAnimationFrame(() => requestAnimationFrame(f)); setTimeout(f, 60); });`
	camOut, err := evalJS(nw, camJS+labelJS+settle+`const r = app.view.root, v = app.viewport;
		return { x: Math.round((r.clientWidth / 2 - v.x) / v.zoom), y: Math.round((r.clientHeight / 2 - v.y) / v.zoom), zoom: +v.zoom.toFixed(3) };`, 5*time.Second)
	if err != nil {
		return nil, fmt.Errorf("camera: %v", err)
	}
	tCam := time.Since(t0)
	png, pw, ph, err := snapshot(nw, float64(w), 10*time.Second)
	if err != nil {
		return nil, err
	}
	var camera any
	_ = json.Unmarshal([]byte(camOut), &camera)
	log.Printf("eye: shot %s for %v: %dx%d %d KB; ready %d ms, camera %d ms, total %d ms (%s)",
		board, seat["name"], pw, ph, len(png)/1024, tReady.Milliseconds(), tCam.Milliseconds(), time.Since(t0).Milliseconds(), windowState(nw))
	return map[string]any{"png": base64.StdEncoding.EncodeToString(png), "width": pw, "height": ph, "camera": camera, "ms": time.Since(t0).Milliseconds()}, nil
}

func intOr(v any, d int) int {
	if f, ok := v.(float64); ok && f > 0 {
		return int(f)
	}
	return d
}

// ---------------------------------------------------------------- menus, recent files

func (sh *Shell) buildMenu() {
	m := application.NewMenu()
	m.AddRole(application.AppMenu)
	file := m.AddSubmenu("File")
	file.Add("New Canvas…").SetAccelerator("CmdOrCtrl+N").OnClick(func(*application.Context) { go sh.newCanvas() })
	file.Add("Open…").SetAccelerator("CmdOrCtrl+O").OnClick(func(*application.Context) { go sh.openDialog() })
	sh.recentMenu = file.AddSubmenu("Open Recent")
	file.AddSeparator()
	file.Add("Close Window").SetAccelerator("CmdOrCtrl+W").OnClick(func(*application.Context) {
		if w := sh.app.Window.Current(); w != nil {
			w.Close()
		}
	})
	m.AddRole(application.EditMenu)
	agents := m.AddSubmenu("Agents")
	agents.Add("Connect Claude Code…").OnClick(func(*application.Context) { go sh.connectClaude() })
	agents.Add("Copy MCP URL (HTTP)").OnClick(func(*application.Context) {
		sh.app.Clipboard.SetText(fmt.Sprintf("http://%s/mcp", sh.side.Base()))
	})
	m.AddRole(application.WindowMenu)
	sh.menu = m
	sh.fillRecent()
	sh.app.Menu.Set(m)
}

func (sh *Shell) fillRecent() {
	sh.recentMenu.Clear()
	sh.mu.Lock()
	recent := append([]string(nil), sh.recent...)
	sh.mu.Unlock()
	for _, f := range recent {
		f := f
		sh.recentMenu.Add(filepath.Base(f) + "  —  " + filepath.Dir(f)).OnClick(func(*application.Context) { sh.requestOpen(f) })
	}
	if len(recent) > 0 {
		sh.recentMenu.AddSeparator()
	}
	sh.recentMenu.Add("Clear Menu").OnClick(func(*application.Context) {
		sh.mu.Lock()
		sh.recent = nil
		sh.mu.Unlock()
		sh.saveRecent()
	})
}

func (sh *Shell) addRecent(f string) {
	sh.mu.Lock()
	out := []string{f}
	for _, x := range sh.recent {
		if x != f && len(out) < 10 {
			out = append(out, x)
		}
	}
	sh.recent = out
	sh.mu.Unlock()
	sh.saveRecent()
}

func (sh *Shell) saveRecent() {
	sh.mu.Lock()
	b, _ := json.MarshalIndent(sh.recent, "", "  ")
	sh.mu.Unlock()
	_ = os.WriteFile(filepath.Join(sh.home, "recent.json"), b, 0o644)
	if sh.menu != nil {
		application.InvokeAsync(func() {
			sh.fillRecent()
			sh.menu.Update()
		})
	}
}

func (sh *Shell) openDialog() {
	path, err := sh.app.Dialog.OpenFile().SetTitle("Open a canvas").AddFilter("Canvas", "*.canvas").PromptForSingleSelection()
	if err == nil && path != "" {
		sh.requestOpen(path)
	}
}

func (sh *Shell) newCanvas() {
	path, err := sh.app.Dialog.SaveFile().SetFilename("Untitled.canvas").AddFilter("Canvas", "*.canvas").PromptForSingleSelection()
	if err == nil && path != "" {
		if filepath.Ext(path) != ".canvas" {
			path += ".canvas"
		}
		sh.requestOpen(path)
	}
}

func (sh *Shell) connectClaude() {
	cmd := mcpCommand()
	sh.app.Clipboard.SetText(cmd)
	log.Printf("connect claude code: %s", cmd)
	sh.app.Dialog.Info().SetTitle("Connect Claude Code").SetMessage(
		"Copied to the clipboard. Run it once in a terminal:\n\n" + cmd +
			"\n\nEvery Claude Code session then sees the open canvases (list_canvases, open_canvas, canvas_screenshot, …); each session gets its own seat. Name a seat with -e CANVAS_AS=Name.").Show()
}
