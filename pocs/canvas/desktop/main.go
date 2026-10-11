package main

import (
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// Canvas desktop (Wails v3 spike): native windows (WKWebView on macOS) show the web app; the Go
// shell starts and supervises the canvas service (desktop/sidecar, a bun-compiled Node/TS binary)
// which owns every open .canvas file and the single MCP endpoint. The shell owns windows, menus,
// file association, and the agents' eyes (a hidden window per agent seat, captured natively).

//go:embed all:frontend/dist
var assets embed.FS

const bundleID = "studio.collie.canvas"

var processStart = time.Now()

func main() {
	home := os.Getenv("CANVAS_HOME")
	if home == "" {
		h, _ := os.UserHomeDir()
		home = filepath.Join(h, "Library", "Application Support", "Canvas")
	}
	_ = os.MkdirAll(home, 0o755)
	lf, err := os.OpenFile(filepath.Join(home, "canvas.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	logw := io.Writer(os.Stderr)
	if err == nil {
		logw = io.MultiWriter(os.Stderr, lf)
	}
	log.SetOutput(logw)
	log.SetFlags(log.Ltime | log.Lmicroseconds)

	if len(os.Args) > 1 && os.Args[1] == "--print-mcp-command" {
		fmt.Println(mcpCommand())
		return
	}

	sh := newShell(home, logw)
	app := application.New(application.Options{
		Name:        "Canvas",
		Description: "An expandable canvas for work and play",
		Assets:      application.AssetOptions{Handler: application.AssetFileServerFS(assets)},
		Mac: application.MacOptions{
			// stays running with no windows: it is the agents' backend too
			ApplicationShouldTerminateAfterLastWindowClosed: false,
		},
		SingleInstance: &application.SingleInstanceOptions{
			UniqueID: bundleID,
			OnSecondInstanceLaunch: func(d application.SecondInstanceData) {
				for _, f := range fileArgs(d.Args[min(1, len(d.Args)):], d.WorkingDir) {
					sh.requestOpen(f)
				}
			},
		},
		OnShutdown: func() { sh.side.Stop() },
	})
	sh.app = app

	app.Event.OnApplicationEvent(events.Common.ApplicationOpenedWithFile, func(e *application.ApplicationEvent) {
		sh.requestOpen(e.Context().Filename())
	})
	app.Event.OnApplicationEvent(events.Common.ApplicationStarted, func(*application.ApplicationEvent) {
		log.Printf("app: started +%d ms", time.Since(processStart).Milliseconds())
		go sh.onStarted(fileArgs(os.Args[1:], ""))
	})
	app.Event.OnApplicationEvent(events.Mac.ApplicationShouldHandleReopen, func(*application.ApplicationEvent) {
		go sh.reopen()
	})

	sh.buildMenu()
	if err := sh.side.Start(); err != nil {
		log.Fatalf("can't start the canvas service: %v", err)
	}
	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}

func fileArgs(args []string, wd string) []string {
	var out []string
	for _, a := range args {
		if a == "" || strings.HasPrefix(a, "-") {
			continue
		}
		if !filepath.IsAbs(a) && wd != "" {
			a = filepath.Join(wd, a)
		}
		out = append(out, a)
	}
	return out
}

// mcpCommand: the command that registers the app's MCP endpoint with Claude Code (stdio shim).
func mcpCommand() string {
	cmd := sidecarCommand()
	q := make([]string, len(cmd))
	for i, c := range cmd {
		q[i] = shellQuote(c)
	}
	return "claude mcp add canvas -- " + strings.Join(q, " ") + " mcp"
}

func shellQuote(s string) string {
	if !strings.ContainsAny(s, " '\"$\\") {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func readJSON(path string, v any) {
	if b, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(b, v)
	}
}
