// Canvas desktop shell (Tauri v2 spike).
//
// - Board windows load the built web app (tauri://localhost/index.html?bridge=ws://127.0.0.1:<port>/b/<id>)
//   with NO Tauri IPC permissions: everything privileged happens here or in the sidecar.
// - The sidecar `canvas-service` (Node SEA, Tauri externalBin) is the agent-bridge for every open file:
//   file ⇄ doc sync, y-websocket, HTTP API, ONE MCP endpoint. We talk to it over stdin/stdout JSON lines.
// - Agent vision: per (board, agent seat) a hidden webview window with its own camera; WKWebView
//   takeSnapshot returns a PNG (see snapshot.rs).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod snapshot;

use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, LogicalSize, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

static T0: OnceLock<Instant> = OnceLock::new();
static LOG: OnceLock<Mutex<Option<std::fs::File>>> = OnceLock::new();
/// Files asked for before the service was up (Finder's open event can beat setup); None once ready.
static EARLY_OPENS: Mutex<Option<Vec<String>>> = Mutex::new(Some(Vec::new()));

fn log(msg: impl AsRef<str>) {
    let ms = T0.get().map(|t| t.elapsed().as_millis()).unwrap_or(0);
    let line = format!("[+{ms:>6}ms] {}", msg.as_ref());
    eprintln!("{line}");
    if let Some(m) = LOG.get() {
        if let Some(f) = m.lock().unwrap().as_mut() {
            let _ = writeln!(f, "{line}");
        }
    }
}

fn epoch_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis()
}

// ------------------------------------------------------------------ the sidecar

struct Service {
    port: u16,
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Child>,
    pending: Mutex<HashMap<u64, mpsc::Sender<Value>>>,
    next: AtomicU64,
}

impl Service {
    fn send(&self, v: &Value) {
        if let Some(s) = self.stdin.lock().unwrap().as_mut() {
            let _ = writeln!(s, "{v}");
            let _ = s.flush();
        }
    }
    /// Ask the service something and wait for the answer.
    fn request(&self, op: &str, mut args: Value) -> Result<Value, String> {
        let rid = self.next.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap().insert(rid, tx);
        args["t"] = json!("req");
        args["rid"] = json!(rid);
        args["op"] = json!(op);
        self.send(&args);
        let r = rx.recv_timeout(Duration::from_secs(10)).map_err(|_| format!("service: {op} timed out"))?;
        if r["ok"].as_bool() == Some(true) {
            Ok(r)
        } else {
            Err(r["error"].as_str().unwrap_or("failed").to_string())
        }
    }
}

fn sidecar_path() -> PathBuf {
    // Tauri copies externalBin next to the main executable (Contents/MacOS in the .app, target/<profile> in dev)
    std::env::current_exe().unwrap().parent().unwrap().join("canvas-service")
}

fn start_service(app: &AppHandle, state_dir: &Path) -> Result<(), String> {
    let t = Instant::now();
    let mut child = Command::new(sidecar_path())
        .args(["serve", "--shell", "--state-dir"])
        .arg(state_dir)
        // `tauri dev` serves the page from the Vite dev server (hot reload): let that origin in
        .args(if cfg!(debug_assertions) { vec!["--allow-origin", "http://localhost:5260"] } else { vec![] })
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("can't start {}: {e}", sidecar_path().display()))?;
    let stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            log(format!("service: {line}"));
        }
    });
    let child = Mutex::new(child);
    let app2 = app.clone();
    let mut reader = BufReader::new(stdout).lines();
    // first line: ready (the rest is handled on a thread once the Service is managed)
    let first = reader.next().and_then(|l| l.ok()).ok_or("service exited before it was ready")?;
    let v: Value = serde_json::from_str(&first).map_err(|e| format!("service said {first}: {e}"))?;
    if v["t"] != "ready" {
        return Err(format!("service: unexpected first line {first}"));
    }
    let port = v["port"].as_u64().unwrap() as u16;
    log(format!("service ready on 127.0.0.1:{port} in {} ms (pid {})", t.elapsed().as_millis(), v["pid"]));
    app.manage(Service { port, stdin: Mutex::new(Some(stdin)), child, pending: Mutex::new(HashMap::new()), next: AtomicU64::new(1) });
    thread::spawn(move || {
        for line in reader.map_while(Result::ok) {
            let Ok(m) = serde_json::from_str::<Value>(&line) else { continue };
            let svc = app2.state::<Service>();
            match m["t"].as_str() {
                Some("res") => {
                    let rid = m["rid"].as_u64().unwrap_or(0);
                    if let Some(tx) = svc.pending.lock().unwrap().remove(&rid) {
                        let _ = tx.send(m);
                    }
                }
                Some("req") => {
                    let app3 = app2.clone();
                    thread::spawn(move || handle_service_request(&app3, m));
                }
                _ => {}
            }
        }
        log("service: stdout closed (service exited)");
    });
    Ok(())
}

fn handle_service_request(app: &AppHandle, m: Value) {
    let rid = m["rid"].clone();
    let res = match m["op"].as_str() {
        Some("screenshot") => agent_screenshot(app, &m),
        Some("show") => {
            let (id, name) = (m["id"].as_str().unwrap_or("").to_string(), m["name"].as_str().unwrap_or("").to_string());
            if let Some(f) = m["file"].as_str() {
                remember_recent(app, f);
            }
            board_window(app, &id, &name).map(|_| json!({}))
        }
        other => Err(format!("unknown op {other:?}")),
    };
    let reply = match res {
        Ok(mut v) => {
            v["ok"] = json!(true);
            v
        }
        Err(e) => json!({ "ok": false, "error": e }),
    };
    let mut reply = reply;
    reply["t"] = json!("res");
    reply["rid"] = rid;
    app.state::<Service>().send(&reply);
}

// ------------------------------------------------------------------ board windows

fn board_url(port: u16, id: &str) -> WebviewUrl {
    WebviewUrl::App(PathBuf::from(format!("index.html?bridge=ws://127.0.0.1:{port}/b/{id}")))
}

fn open_file(app: &AppHandle, file: &str) {
    if let Some(q) = EARLY_OPENS.lock().unwrap().as_mut() {
        log(format!("open {file}: queued until the service is up"));
        q.push(file.to_string());
        return;
    }
    let svc = app.state::<Service>();
    match svc.request("open", json!({ "file": file })) {
        Ok(r) => {
            let (id, name, path) = (r["id"].as_str().unwrap().to_string(), r["name"].as_str().unwrap().to_string(), r["file"].as_str().unwrap().to_string());
            remember_recent(app, &path);
            if let Err(e) = board_window(app, &id, &name) {
                log(format!("window for {name}: {e}"));
            }
        }
        Err(e) => {
            log(format!("open {file}: {e}"));
            app.dialog().message(format!("Couldn't open {file}:\n{e}")).kind(MessageDialogKind::Error).show(|_| {});
        }
    }
}

fn board_window(app: &AppHandle, id: &str, name: &str) -> Result<(), String> {
    let label = format!("board-{id}");
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    let port = app.state::<Service>().port;
    let w = WebviewWindowBuilder::new(app, &label, board_url(port, id))
        .title(format!("{name} — Canvas"))
        .inner_size(1200.0, 800.0)
        .build()
        .map_err(|e| e.to_string())?;
    // measure "board visible": page synced with the service and nodes rendered
    let name = name.to_string();
    thread::spawn(move || {
        let t = Instant::now();
        for _ in 0..200 {
            if let Ok(s) = snapshot::eval_js(&w, "String(!!(window.room && window.room.provider && window.room.provider.synced) && document.querySelectorAll('.cv-world > *').length)") {
                if s != "false" && s != "0" && !s.is_empty() {
                    log(format!("board visible: {name} ({s} elements) {} ms after window, {} ms after launch (epoch {}); web/gpu process {:?}", t.elapsed().as_millis(), T0.get().unwrap().elapsed().as_millis(), epoch_ms(), snapshot::web_pid(&w)));
                    return;
                }
            }
            thread::sleep(Duration::from_millis(25));
        }
        log(format!("board {name}: not visible after 5 s"));
    });
    Ok(())
}

// ------------------------------------------------------------------ agent vision

/// A hidden window per (board, agent seat): its own camera, never moves anyone's view.
fn agent_screenshot(app: &AppHandle, m: &Value) -> Result<Value, String> {
    let t = Instant::now();
    let id = m["id"].as_str().ok_or("no board id")?;
    let seat = m["seat"].as_str().unwrap_or("Agent");
    let slug: String = seat.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' }).collect();
    let (w, h) = (m["width"].as_f64().unwrap_or(1000.0).clamp(200.0, 4000.0), m["height"].as_f64().unwrap_or(750.0).clamp(150.0, 4000.0));
    let label = format!("seat-{id}-{slug}");
    let mode = std::env::var("CANVAS_CAPTURE_MODE").unwrap_or_else(|_| "hidden".into());
    let mut timings = serde_json::Map::new();
    let win = match app.get_webview_window(&label) {
        Some(win) => {
            let _ = win.set_size(LogicalSize::new(w, h));
            win
        }
        None => {
            let port = app.state::<Service>().port;
            // own (ephemeral) storage + a player identity of its own, so the view isn't the human
            let ident = json!({ "id": format!("view-{slug}"), "name": format!("{seat} (view)"), "color": "#9a9a9a", "named": true });
            // + no transitions/animations: hidden views get no animation frames, so a snapshot would
            // catch them mid-way; the agent sees the settled state
            let init = format!(
                "try {{ localStorage.setItem('canvas-poc:player', {}); }} catch (e) {{}}\n\
                 document.addEventListener('DOMContentLoaded', () => {{ const s = document.createElement('style'); s.textContent = '*, *::before, *::after {{ transition: none !important; animation: none !important; }}'; document.head.append(s); }});",
                serde_json::to_string(&ident.to_string()).unwrap()
            );
            let mut b = WebviewWindowBuilder::new(app, &label, board_url(port, id))
                .title(format!("{seat}'s view"))
                .inner_size(w, h)
                .incognito(true)
                .decorations(false)
                .initialization_script(init)
                .focused(false);
            b = match mode.as_str() {
                "offscreen" => b.visible(true).position(-30000.0, -30000.0),
                "visible" => b.visible(true).position(40.0, 40.0),
                _ => b.visible(false),
            };
            let win = b.build().map_err(|e| e.to_string())?;
            #[cfg(target_os = "macos")]
            if mode == "transparent" {
                snapshot::make_invisible(&win);
            }
            #[cfg(target_os = "macos")]
            if std::env::var("CANVAS_KEEP_RENDERING").as_deref() == Ok("1") {
                log(format!("{label}: keep rendering: {}", snapshot::keep_rendering(&win)));
            }
            timings.insert("createMs".into(), json!(t.elapsed().as_millis()));
            win
        }
    };
    // wait until the page has synced with the service
    let t_sync = Instant::now();
    let mut synced = false;
    for _ in 0..300 {
        if snapshot::eval_js(&win, "String(!!(window.room && window.room.provider && window.room.provider.synced))").as_deref() == Ok("true") {
            synced = true;
            break;
        }
        thread::sleep(Duration::from_millis(20));
    }
    if !synced {
        return Err("the agent view didn't sync with the board within 6 s".into());
    }
    timings.insert("syncMs".into(), json!(t_sync.elapsed().as_millis()));
    // camera
    let cam = if let Some(nodes) = m["nodes"].as_array().filter(|a| !a.is_empty()) {
        format!("(() => {{ const ids = {}; app.view.fit(40, app.store.doc.visible.filter(n => ids.includes(n.id))); }})()", Value::Array(nodes.clone()))
    } else if let (Some(x), Some(y)) = (m["x"].as_f64(), m["y"].as_f64()) {
        let z = m["zoom"].as_f64().unwrap_or(1.0);
        format!("app.viewport.set({}, {}, {z})", -x * z, -y * z)
    } else {
        "app.view.fit(40)".into()
    };
    // set the camera, then wait two animation frames (does a hidden page still render?)
    let t_frame = Instant::now();
    snapshot::eval_js(&win, &format!("window.__cvFrame = 0; {cam}; requestAnimationFrame(() => requestAnimationFrame(() => window.__cvFrame = 1)); 'ok'"))?;
    let mut framed = false;
    // hidden windows get no animation frames (WebKit stops rAF for them); takeSnapshot still paints
    // the current DOM, so only rAF-driven content (animations, canvas drawing) would lag
    for _ in 0..if mode == "hidden" { 1 } else { 10 } {
        thread::sleep(Duration::from_millis(16));
        if snapshot::eval_js(&win, "String(window.__cvFrame)").as_deref() == Ok("1") {
            framed = true;
            break;
        }
    }
    timings.insert("frameMs".into(), json!(t_frame.elapsed().as_millis()));
    timings.insert("rafRan".into(), json!(framed));
    let t_snap = Instant::now();
    // 1 image px per CSS px (not Retina 2x): ~4x fewer bytes and image tokens; `scale: 2` for detail
    let scale = m["scale"].as_f64().unwrap_or(1.0).clamp(0.25, 2.0);
    // a hidden window isn't on a screen, so its own scale factor can read 1.0: take the screen's
    let backing = win.primary_monitor().ok().flatten().map(|m| m.scale_factor()).unwrap_or(2.0);
    let png = snapshot::snapshot_png(&win, w * scale / backing)?;
    timings.insert("snapshotMs".into(), json!(t_snap.elapsed().as_millis()));
    timings.insert("totalMs".into(), json!(t.elapsed().as_millis()));
    let (pw, ph) = png_size(&png);
    log(format!("screenshot {label} ({mode}): {pw}x{ph}, {} bytes, {:?}; web/gpu process {:?}", png.len(), timings, snapshot::web_pid(&win)));
    use base64::Engine;
    Ok(json!({ "png": base64::engine::general_purpose::STANDARD.encode(&png), "width": pw, "height": ph, "timings": timings }))
}

fn png_size(png: &[u8]) -> (u32, u32) {
    if png.len() < 24 {
        return (0, 0);
    }
    (u32::from_be_bytes(png[16..20].try_into().unwrap()), u32::from_be_bytes(png[20..24].try_into().unwrap()))
}

// ------------------------------------------------------------------ recent files + menu

fn recent_path(app: &AppHandle) -> PathBuf {
    app.path().app_data_dir().unwrap().join("recent.json")
}

fn recent(app: &AppHandle) -> Vec<String> {
    std::fs::read_to_string(recent_path(app)).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn remember_recent(app: &AppHandle, file: &str) {
    let mut r = recent(app);
    r.retain(|f| f != file);
    r.insert(0, file.to_string());
    r.truncate(10);
    let _ = std::fs::write(recent_path(app), serde_json::to_string_pretty(&r).unwrap());
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Ok(m) = build_menu(&app2) {
            let _ = app2.set_menu(m);
        }
    });
}

fn mcp_command() -> String {
    format!("claude mcp add canvas -- '{}' mcp", sidecar_path().display())
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let recent_items: Vec<MenuItem<tauri::Wry>> = recent(app)
        .iter()
        .enumerate()
        .map(|(i, f)| MenuItem::with_id(app, format!("recent:{i}"), f, true, None::<&str>))
        .collect::<Result<_, _>>()?;
    let recent_refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = recent_items.iter().map(|m| m as &dyn tauri::menu::IsMenuItem<tauri::Wry>).collect();
    let open_recent = Submenu::with_items(app, "Open Recent", !recent_items.is_empty(), &recent_refs)?;
    let app_menu = Submenu::with_items(
        app,
        "Canvas",
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "quit", "Quit Canvas", true, Some("CmdOrCtrl+Q"))?,
        ],
    )?;
    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &MenuItem::with_id(app, "open", "Open…", true, Some("CmdOrCtrl+O"))?,
            &open_recent,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let agents = Submenu::with_items(
        app,
        "Agents",
        true,
        &[
            &MenuItem::with_id(app, "connect-claude", "Connect Claude Code…", true, None::<&str>)?,
            &MenuItem::with_id(app, "show-agent-views", "Show Agent Views", true, None::<&str>)?,
        ],
    )?;
    let window = Submenu::with_items(app, "Window", true, &[&PredefinedMenuItem::minimize(app, None)?, &PredefinedMenuItem::fullscreen(app, None)?])?;
    Menu::with_items(app, &[&app_menu, &file, &edit, &agents, &window])
}

fn on_menu(app: &AppHandle, id: &str) {
    match id {
        "quit" => app.exit(0),
        "open" => {
            let app2 = app.clone();
            app.dialog().file().add_filter("Canvas", &["canvas"]).pick_file(move |f| {
                if let Some(p) = f.and_then(|p| p.into_path().ok()) {
                    let app3 = app2.clone();
                    thread::spawn(move || open_file(&app3, &p.to_string_lossy()));
                }
            });
        }
        "connect-claude" => {
            let cmd = mcp_command();
            let copied = Command::new("pbcopy").stdin(Stdio::piped()).spawn().and_then(|mut c| {
                c.stdin.take().unwrap().write_all(cmd.as_bytes())?;
                c.wait()
            });
            log(format!("connect: {cmd} (copied: {})", copied.is_ok()));
            let port = app.state::<Service>().port;
            app.dialog()
                .message(format!(
                    "Run this in a terminal (copied to the clipboard):\n\n{cmd}\n\nOne endpoint for every open canvas; each Claude session gets its own seat. Name a seat: add --as \"Name\" at the end.\n\nOr over HTTP while the app runs (port changes per launch):\nclaude mcp add --transport http canvas http://127.0.0.1:{port}/mcp"
                ))
                .title("Connect Claude Code")
                .show(|_| {});
        }
        "show-agent-views" => {
            for (label, w) in app.webview_windows() {
                if label.starts_with("seat-") {
                    let _ = w.set_position(tauri::LogicalPosition::new(80.0, 80.0));
                    let _ = w.show();
                }
            }
        }
        s if s.starts_with("recent:") => {
            let i: usize = s[7..].parse().unwrap_or(0);
            if let Some(f) = recent(app).get(i).cloned() {
                let app2 = app.clone();
                thread::spawn(move || open_file(&app2, &f));
            }
        }
        _ => {}
    }
}

// ------------------------------------------------------------------ main

fn main() {
    T0.get_or_init(Instant::now);
    let launch_epoch = epoch_ms();
    let cli_files: Vec<String> = std::env::args().skip(1).filter(|a| a.ends_with(".canvas")).collect();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .menu(|app| build_menu(app))
        .on_menu_event(|app, e| on_menu(app, e.id().as_ref()))
        .setup(move |app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            LOG.get_or_init(|| Mutex::new(OpenOptions::new().create(true).append(true).open(dir.join("canvas.log")).ok()));
            log(format!("launch (epoch {launch_epoch}); state {}", dir.display()));
            start_service(app.handle(), &dir).map_err(|e| {
                log(format!("service failed: {e}"));
                e
            })?;
            log(format!("connect command: {}", mcp_command()));
            let early = EARLY_OPENS.lock().unwrap().take().unwrap_or_default();
            for f in cli_files.iter().chain(early.iter()) {
                let (app2, f) = (app.handle().clone(), f.clone());
                thread::spawn(move || open_file(&app2, &f));
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the app");

    app.run(|app, event| match event {
        // Finder double-click / `open -a Canvas x.canvas` (also while running)
        RunEvent::Opened { urls } => {
            for u in urls {
                if let Ok(p) = u.to_file_path() {
                    let app2 = app.clone();
                    thread::spawn(move || open_file(&app2, &p.to_string_lossy()));
                }
            }
        }
        // closing the last window keeps the app (and the agent endpoint) running, like a Mac app
        RunEvent::ExitRequested { code: None, api, .. } => api.prevent_exit(),
        RunEvent::Exit => {
            if let Some(svc) = app.try_state::<Service>() {
                // closing stdin = the service flushes every file and exits
                let mut child = svc.child.lock().unwrap();
                drop(svc.stdin.lock().unwrap().take());
                for _ in 0..40 {
                    if let Ok(Some(_)) = child.try_wait() {
                        break;
                    }
                    thread::sleep(Duration::from_millis(50));
                }
                let _ = child.kill();
                log("exit: service stopped");
            }
        }
        _ => {}
    });
}

