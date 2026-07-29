// Folklore desktop — cross-platform tray shell + onboard wizard + status.
//
// The heavy lifting lives in the Node CLI (`@usefolklore/folklore`): daemon,
// MCP server, and the `onboard` wizard that wires every AI provider on the
// machine. This shell provides the GUI: a tray icon with live daemon status,
// a dashboard/wizard window, and daemon controls. One codebase → macOS /
// Windows / Linux.
//
// Every command that shells out to the CLI is `#[tauri::command(async)]` — the
// CLI can block for tens of seconds (first-run npm install), and sync commands
// run on the main thread, freezing the UI and the tray.
//
// Status never shells out: the daemon heartbeats `daemon-status.json`, graph
// saves sidecar `graph-meta.json`, serves land in `contribution.json`. The
// snapshot is pure file reads + a pid liveness probe, cheap enough to poll.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;
use serde_json::{json, Value};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Wry,
};

const TRAY_ID: &str = "folklore-tray";
/// Heartbeat is 30s; anything older than 90s is a dead or wedged daemon.
const STATUS_FRESH_SECS: u64 = 90;

/// Numeric key for a version-directory name (`v22.11.0` → [22, 11, 0]) so
/// "latest installed node" compares numerically — a lexicographic sort ranks
/// `v9` above `v22`.
fn version_key(path: &str) -> Vec<u64> {
    Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default()
        .split(|c: char| !c.is_ascii_digit())
        .filter_map(|p| p.parse().ok())
        .collect()
}

/// Directories where a globally-installed `folklore` / `node` / `npx` might live.
/// A double-clicked GUI app inherits neither the shell PATH nor version-manager
/// shims (nvm / fnm / volta / asdf), so we have to look ourselves. Ordered most-
/// to least specific; version-manager dirs are expanded by globbing their
/// `versions/node/*/bin` roots.
fn bin_dirs() -> Vec<String> {
    let mut dirs: Vec<String> = Vec::new();
    if let Ok(home) = std::env::var("HOME") {
        // Global npm prefixes.
        dirs.push(format!("{home}/.npm-global/bin"));
        dirs.push(format!("{home}/.local/bin"));
        dirs.push(format!("{home}/.volta/bin"));
        dirs.push(format!("{home}/.bun/bin"));
        // nvm / fnm keep a bin dir per installed node version — pick the newest.
        for base in [
            format!("{home}/.nvm/versions/node"),
            format!("{home}/.local/share/fnm/node-versions"),
            format!("{home}/Library/Application Support/fnm/node-versions"),
        ] {
            if let Ok(entries) = std::fs::read_dir(&base) {
                let mut versions: Vec<String> = entries
                    .filter_map(|e| e.ok().map(|e| e.path().to_string_lossy().to_string()))
                    .collect();
                versions.sort_by_key(|p| version_key(p));
                if let Some(latest) = versions.last() {
                    dirs.push(format!("{latest}/bin"));         // nvm layout
                    dirs.push(format!("{latest}/installation/bin")); // fnm layout
                }
            }
        }
    }
    for p in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
        dirs.push(p.to_string());
    }
    dirs
}

/// First `<dir>/<name>` (or `<name>.cmd` on Windows) that exists.
fn find_in_dirs(name: &str) -> Option<String> {
    let names: Vec<String> = if cfg!(target_os = "windows") {
        vec![format!("{name}.cmd"), format!("{name}.exe"), name.to_string()]
    } else {
        vec![name.to_string()]
    };
    for dir in bin_dirs() {
        for n in &names {
            let cand = format!("{dir}/{n}");
            if std::path::Path::new(&cand).exists() {
                return Some(cand);
            }
        }
    }
    None
}

/// `which`/`where` lookup that returns the resolved absolute path.
fn which_path(bin: &str) -> Option<String> {
    let (probe, arg) = if cfg!(target_os = "windows") { ("where", bin) } else { ("which", bin) };
    let out = Command::new(probe).arg(arg).output().ok()?;
    if !out.status.success() { return None; }
    String::from_utf8_lossy(&out.stdout).lines().next().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

// ─────────────── bundled Node runtime ───────────────

/// The Node binary bundled into the app (populated per-platform by the desktop
/// CI), if present. Unix dist: node/bin/node ; Windows: node/node.exe.
fn bundled_node(app: &AppHandle) -> Option<PathBuf> {
    let res = app.path().resource_dir().ok()?;
    let unix = res.join("node").join("bin").join("node");
    if unix.exists() { return Some(unix); }
    let win = res.join("node").join("node.exe");
    if win.exists() { return Some(win); }
    None
}

/// npm's cli.js inside the bundled dist. The dist's `bin/npm`/`bin/npx` symlinks
/// get flattened by the app bundler into mis-located copies that fail to resolve
/// npm's lib, so we always invoke npm-cli.js directly with the bundled node. Unix
/// keeps npm under lib/, Windows at the dist root.
fn bundled_npm_cli(app: &AppHandle) -> Option<PathBuf> {
    let res = app.path().resource_dir().ok()?;
    for p in [
        res.join("node/lib/node_modules/npm/bin/npm-cli.js"),
        res.join("node/node_modules/npm/bin/npm-cli.js"),
    ] {
        if p.exists() { return Some(p); }
    }
    None
}

/// The installed CLI entry script under `prefix`, if present. npm's global layout
/// is `lib/node_modules/...` on unix, `node_modules/...` on Windows.
fn installed_cli_entry(prefix: &Path) -> Option<PathBuf> {
    for p in [
        prefix.join("lib/node_modules/@usefolklore/folklore/bin/folklore.js"),
        prefix.join("node_modules/@usefolklore/folklore/bin/folklore.js"),
    ] {
        if p.exists() { return Some(p); }
    }
    None
}

/// PATH for spawned children: bundled Node bin dir first (so npm post-install
/// scripts find `node`), then version-manager / global dirs, then the inherited
/// PATH.
fn child_path(app: &AppHandle) -> String {
    let sep = if cfg!(target_os = "windows") { ";" } else { ":" };
    let mut parts: Vec<String> = Vec::new();
    if let Some(node) = bundled_node(app) {
        if let Some(dir) = node.parent() {
            parts.push(dir.to_string_lossy().to_string());
        }
    }
    parts.extend(bin_dirs());
    if let Ok(existing) = std::env::var("PATH") {
        parts.push(existing);
    }
    parts.join(sep)
}

/// Ensure the folklore CLI is installed against the bundled Node, returning
/// (node, entry-js). Installs once into app data on first run (~20s, fetching the
/// platform's native prebuilds); a no-op afterward. Running the entry `.js`
/// directly with node sidesteps the unreliable bundled bin symlinks — this is the
/// verified zero-system-Node path.
fn ensure_bundled_cli(app: &AppHandle) -> Option<(PathBuf, PathBuf)> {
    let node = bundled_node(app)?;
    let npm_cli = bundled_npm_cli(app)?;
    let prefix = app.path().app_data_dir().ok()?.join("cli");
    if let Some(entry) = installed_cli_entry(&prefix) {
        return Some((node, entry));
    }
    let _ = std::fs::create_dir_all(&prefix);
    let status = Command::new(&node)
        .arg(&npm_cli)
        .args(["install", "-g", "@usefolklore/folklore", "--no-audit", "--no-fund", "--prefix"])
        .arg(&prefix)
        .env("PATH", child_path(app))
        .status()
        .ok()?;
    if !status.success() { return None; }
    installed_cli_entry(&prefix).map(|entry| (node, entry))
}

/// Resolve how to run the folklore CLI. Order: a system-installed `folklore`
/// (fastest); else the bundled Node running the app-installed CLI (zero system
/// Node); else system `npx` on the published package; else a clear "install
/// Node" error.
fn resolve_cli(app: &AppHandle) -> Result<(String, Vec<String>), String> {
    if let Some(f) = find_in_dirs("folklore").or_else(|| which_path("folklore")) {
        return Ok((f, vec![]));
    }
    if let Some((node, entry)) = ensure_bundled_cli(app) {
        return Ok((node.to_string_lossy().to_string(), vec![entry.to_string_lossy().to_string()]));
    }
    if let Some(npx) = find_in_dirs("npx").or_else(|| which_path("npx")) {
        return Ok((npx, vec!["--yes".into(), "@usefolklore/folklore".into()]));
    }
    Err("Node.js was not found and this build has no bundled runtime. \
         Install Node (nodejs.org) or the folklore CLI \
         (npm i -g @usefolklore/folklore), then try again."
        .into())
}

/// Run a folklore CLI subcommand to completion and return its output.
fn run_cli(app: &AppHandle, sub: &[&str]) -> Result<String, String> {
    let (program, mut args) = resolve_cli(app)?;
    for s in sub {
        args.push((*s).to_string());
    }
    let out = Command::new(&program)
        .args(&args)
        .env("PATH", child_path(app))
        .env("NO_COLOR", "1")
        .output()
        .map_err(|e| format!("Could not run the folklore CLI ({program}): {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    if out.status.success() {
        Ok(if stdout.trim().is_empty() { stderr } else { stdout })
    } else {
        Err(if stderr.trim().is_empty() { stdout } else { stderr })
    }
}

/// Run a folklore CLI subcommand, emitting every output line as `event` so the
/// wizard can show live progress instead of a frozen spinner. Returns the tail
/// of stdout on success, the last meaningful line on failure.
fn run_cli_streaming(app: &AppHandle, sub: &[&str], event: &str) -> Result<String, String> {
    let (program, mut args) = resolve_cli(app)?;
    for s in sub {
        args.push((*s).to_string());
    }
    let mut child = Command::new(&program)
        .args(&args)
        .env("PATH", child_path(app))
        .env("NO_COLOR", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not run the folklore CLI ({program}): {e}"))?;

    let stderr = child.stderr.take();
    let app_err = app.clone();
    let event_err = event.to_string();
    let err_reader = std::thread::spawn(move || -> Vec<String> {
        let mut lines = Vec::new();
        if let Some(err) = stderr {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                let _ = app_err.emit(&event_err, line.clone());
                lines.push(line);
            }
        }
        lines
    });

    let mut tail: VecDeque<String> = VecDeque::new();
    if let Some(out) = child.stdout.take() {
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            let _ = app.emit(event, line.clone());
            if tail.len() >= 12 {
                tail.pop_front();
            }
            tail.push_back(line);
        }
    }

    let err_lines = err_reader.join().unwrap_or_default();
    let status = child
        .wait()
        .map_err(|e| format!("folklore CLI did not exit cleanly: {e}"))?;
    if status.success() {
        Ok(tail.into_iter().collect::<Vec<_>>().join("\n"))
    } else {
        Err(err_lines
            .iter()
            .rev()
            .find(|l| !l.trim().is_empty())
            .cloned()
            .or_else(|| tail.iter().rev().find(|l| !l.trim().is_empty()).cloned())
            .unwrap_or_else(|| format!("folklore exited with {status}")))
    }
}

// ─────────────── status snapshot (pure file reads) ───────────────

/// The folklore data home — `$FOLKLORE_HOME` or `~/.folklore`.
fn folklore_home() -> Option<PathBuf> {
    if let Ok(h) = std::env::var("FOLKLORE_HOME") {
        if !h.is_empty() {
            return Some(PathBuf::from(h));
        }
    }
    std::env::var("HOME").ok().map(|h| PathBuf::from(h).join(".folklore"))
}

/// Whether onboarding has completed at least once — the peer identity is the
/// first durable artifact the wizard creates.
fn is_onboarded() -> bool {
    folklore_home()
        .map(|h| h.join("peer-identity.json").exists() || h.join("identity").exists())
        .unwrap_or(false)
}

fn pid_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        // Windows: no cheap builtin probe — trust heartbeat freshness instead.
        let _ = pid;
        true
    }
}

fn read_json(path: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn file_age_secs(path: &Path) -> Option<u64> {
    std::fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .elapsed()
        .ok()
        .map(|e| e.as_secs())
}

/// One coherent picture for the dashboard and the tray:
/// daemon liveness (heartbeat file cross-checked against pid, with the plain
/// pid file as fallback for daemons predating the heartbeat), live peer count,
/// graph size from the save-time sidecar, and contribution scores.
fn gather_status() -> Value {
    let mut daemon_running = false;
    let mut daemon_pid: Option<u64> = None;
    let mut p2p = false;
    let mut connected_peers: u64 = 0;
    let mut heartbeat_fresh = false;
    let mut graph_nodes: Option<u64> = None;
    let mut graph_edges: Option<u64> = None;
    let mut reputation: u64 = 0;
    let mut served_searches: u64 = 0;
    let mut served_fetches: u64 = 0;
    let mut peers_helped: u64 = 0;

    if let Some(home) = folklore_home() {
        // Liveness candidates: heartbeat pid first, plain pid file second.
        let status_path = home.join("daemon-status.json");
        let status = read_json(&status_path);
        let mut candidates: Vec<u64> = Vec::new();
        if let Some(p) = status.as_ref().and_then(|v| v.get("pid")).and_then(Value::as_u64) {
            candidates.push(p);
        }
        if let Ok(s) = std::fs::read_to_string(home.join("daemon.pid")) {
            if let Ok(p) = s.trim().parse::<u64>() {
                if !candidates.contains(&p) {
                    candidates.push(p);
                }
            }
        }
        for p in candidates {
            if pid_alive(p as u32) {
                daemon_running = true;
                daemon_pid = Some(p);
                break;
            }
        }
        heartbeat_fresh = file_age_secs(&status_path)
            .map(|a| a < STATUS_FRESH_SECS)
            .unwrap_or(false);
        if daemon_running && heartbeat_fresh {
            if let Some(v) = status.as_ref() {
                p2p = v.get("p2p").and_then(Value::as_bool).unwrap_or(false);
                connected_peers = v.get("connected_peers").and_then(Value::as_u64).unwrap_or(0);
            }
        }

        if let Some(meta) = read_json(&home.join("graph-meta.json")) {
            graph_nodes = meta.get("nodes").and_then(Value::as_u64);
            graph_edges = meta.get("edges").and_then(Value::as_u64);
        }

        if let Some(c) = read_json(&home.join("contribution.json")) {
            reputation = c.get("reputation").and_then(Value::as_u64).unwrap_or(0);
            served_searches = c.get("served_searches").and_then(Value::as_u64).unwrap_or(0);
            served_fetches = c.get("served_fetches").and_then(Value::as_u64).unwrap_or(0);
            peers_helped = c
                .get("peers_helped")
                .and_then(Value::as_array)
                .map(|a| a.len() as u64)
                .unwrap_or(0);
        }
    }

    json!({
        "daemon_running": daemon_running,
        "daemon_pid": daemon_pid,
        "p2p": p2p,
        "connected_peers": connected_peers,
        "heartbeat_fresh": heartbeat_fresh,
        "graph_nodes": graph_nodes,
        "graph_edges": graph_edges,
        "reputation": reputation,
        "served_searches": served_searches,
        "served_fetches": served_fetches,
        "peers_helped": peers_helped,
        "onboarded": is_onboarded(),
    })
}

// ─────────────── commands ───────────────

/// Run the full onboard wizard non-interactively: identity, Claude Code hooks,
/// every detected AI provider, and start the daemon. Progress lines stream to
/// the wizard as `onboard-line` events.
#[tauri::command(async)]
fn run_onboard(app: AppHandle) -> Result<String, String> {
    let out = run_cli_streaming(&app, &["onboard", "--yes", "--no-sessions"], "onboard-line");
    refresh_tray(&app);
    out
}

/// The provider-integration table (which harnesses are detected / wired).
#[tauri::command(async)]
fn harness_list(app: AppHandle) -> Result<String, String> {
    run_cli(&app, &["harness", "list"])
}

#[tauri::command(async)]
fn daemon_start(app: AppHandle) -> Result<String, String> {
    let out = run_cli(&app, &["daemon", "start"]);
    refresh_tray(&app);
    out
}

#[tauri::command(async)]
fn daemon_stop(app: AppHandle) -> Result<String, String> {
    let out = run_cli(&app, &["daemon", "stop"]);
    refresh_tray(&app);
    out
}

/// Live status for the dashboard: daemon, peers, graph size, contribution.
/// Pure file reads — cheap enough for the frontend to poll every few seconds.
#[tauri::command(async)]
fn status_snapshot() -> Value {
    gather_status()
}

/// The last `n` lines of the append-only peer activity feed
/// (`<home>/activity-feed.jsonl`), newest last — the same feed the island tails.
/// Returns the raw JSONL lines; the island parses them. Empty when the daemon
/// hasn't written any activity yet.
#[tauri::command(async)]
fn recent_activity(n: usize) -> Vec<String> {
    let Some(path) = folklore_home().map(|h| h.join("activity-feed.jsonl")) else {
        return vec![];
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return vec![];
    };
    let lines: Vec<String> = text.lines().filter(|l| !l.trim().is_empty()).map(|l| l.to_string()).collect();
    let start = lines.len().saturating_sub(n);
    lines[start..].to_vec()
}

// ─────────────── windows + tray ───────────────

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

// ─────────────── notch island ───────────────

/// Lift the island's NSWindow above the menu bar so it can hug the notch.
/// Tauri's always-on-top maps to NSFloatingWindowLevel, which macOS keeps
/// below the menu bar — the window gets pushed under it and renders as a
/// floating box instead of a dynamic island. NSStatusWindowLevel (25) draws
/// over the bar; the collection behavior keeps it on every Space including
/// fullscreen apps, pinned in place during Space swipes.
#[cfg(target_os = "macos")]
fn style_island(win: &tauri::WebviewWindow) {
    use objc::runtime::Object;
    use objc::{msg_send, sel, sel_impl};
    if let Ok(ptr) = win.ns_window() {
        let ns = ptr as *mut Object;
        unsafe {
            let _: () = msg_send![ns, setLevel: 25isize];
            // canJoinAllSpaces (1<<0) | stationary (1<<4) | fullScreenAuxiliary (1<<8)
            let _: () = msg_send![ns, setCollectionBehavior: (1usize << 0) | (1usize << 4) | (1usize << 8)];
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn style_island(_win: &tauri::WebviewWindow) {}

/// Pin the island to the exact top-center of the primary screen — flush with
/// the notch on a MacBook, a top-center pill elsewhere.
fn position_island(win: &tauri::WebviewWindow) {
    if let Some(mon) = win.primary_monitor().ok().flatten() {
        let scale = mon.scale_factor();
        let mon_w = mon.size().width as f64;
        let win_w = win.outer_size().map(|s| s.width as f64).unwrap_or(460.0 * scale);
        let x = (mon.position().x as f64) + (mon_w - win_w) / 2.0;
        let _ = win.set_position(tauri::PhysicalPosition::new(x, mon.position().y as f64));
    }
}

/// Slide the island out with a payload. The webview owns the animation and
/// auto-collapse; showing without focus keeps the island from stealing the
/// user's keyboard or switching Spaces.
fn present_island(app: &AppHandle, event: &str, payload: Value) {
    let Some(win) = app.get_webview_window("island") else { return };
    position_island(&win);
    let _ = app.emit(event, payload);
    let _ = win.show();
}

/// Tray click: toggle a status card in the island (daemon, peers, graph).
fn toggle_island(app: &AppHandle) {
    let Some(win) = app.get_webview_window("island") else { return };
    if win.is_visible().unwrap_or(false) {
        let _ = app.emit("island-dismiss", json!({}));
        return;
    }
    present_island(app, "island-status", gather_status());
}

/// Tail `activity-feed.jsonl` and pop the island for every new peer event —
/// the network reaching you, visible while you work. Skips history at boot;
/// 1s mtime/size polling is cheap and avoids a file-watcher dependency.
fn spawn_activity_watcher(app: AppHandle) {
    std::thread::spawn(move || {
        let path = match folklore_home() {
            Some(h) => h.join("activity-feed.jsonl"),
            None => return,
        };
        let mut seen = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        loop {
            std::thread::sleep(Duration::from_secs(1));
            let len = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            if len < seen {
                seen = len; // feed rotated/truncated
                continue;
            }
            if len == seen {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else { continue };
            let new_tail = text.get(seen as usize..).unwrap_or("");
            seen = len;
            if let Some(ev) = new_tail
                .lines()
                .filter_map(|l| serde_json::from_str::<Value>(l.trim()).ok())
                .last()
            {
                let app2 = app.clone();
                let _ = app.run_on_main_thread(move || {
                    present_island(&app2, "island-activity", ev);
                });
            }
        }
    });
}

/// 102_345 → "102.3K" — menu real estate is tight.
fn compact(n: u64) -> String {
    match n {
        0..=9_999 => n.to_string(),
        10_000..=999_999 => format!("{:.1}K", n as f64 / 1_000.0),
        _ => format!("{:.1}M", n as f64 / 1_000_000.0),
    }
}

fn opt_compact(v: Option<u64>) -> String {
    v.map(compact).unwrap_or_else(|| "—".to_string())
}

fn status_line(snap: &Value) -> String {
    let running = snap.get("daemon_running").and_then(Value::as_bool).unwrap_or(false);
    if !running {
        return "○ Daemon stopped".to_string();
    }
    let peers = snap.get("connected_peers").and_then(Value::as_u64).unwrap_or(0);
    let fresh = snap.get("heartbeat_fresh").and_then(Value::as_bool).unwrap_or(false);
    if fresh {
        format!("● Running — {peers} peer{} connected", if peers == 1 { "" } else { "s" })
    } else {
        "● Running".to_string()
    }
}

/// The tray menu is the at-a-glance dashboard: daemon, peers, graph size,
/// and contribution as disabled info rows, then ONE daemon toggle whose
/// label matches what it will do.
fn build_tray_menu(app: &AppHandle, snap: &Value) -> tauri::Result<Menu<Wry>> {
    let running = snap.get("daemon_running").and_then(Value::as_bool).unwrap_or(false);
    let nodes = opt_compact(snap.get("graph_nodes").and_then(Value::as_u64));
    let edges = opt_compact(snap.get("graph_edges").and_then(Value::as_u64));
    let rep = snap.get("reputation").and_then(Value::as_u64).unwrap_or(0);
    let served = snap.get("served_searches").and_then(Value::as_u64).unwrap_or(0)
        + snap.get("served_fetches").and_then(Value::as_u64).unwrap_or(0);
    let helped = snap.get("peers_helped").and_then(Value::as_u64).unwrap_or(0);

    let status = MenuItem::with_id(app, "status", status_line(snap), false, None::<&str>)?;
    let graph = MenuItem::with_id(
        app,
        "graph",
        format!("Graph: {nodes} nodes · {edges} edges"),
        false,
        None::<&str>,
    )?;
    let score = MenuItem::with_id(
        app,
        "score",
        format!("Rep {rep} · {} served · {} peers helped", compact(served), compact(helped)),
        false,
        None::<&str>,
    )?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let activity = MenuItem::with_id(app, "activity", "Peer Activity", true, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Open Folklore", true, None::<&str>)?;
    let toggle = MenuItem::with_id(
        app,
        "daemon-toggle",
        if running { "Stop Daemon" } else { "Start Daemon" },
        true,
        None::<&str>,
    )?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Folklore", true, None::<&str>)?;
    Menu::with_items(app, &[&status, &graph, &score, &sep1, &activity, &open, &toggle, &sep2, &quit])
}


/// Rebuild the tray menu + tooltip from a fresh snapshot. Safe to call from
/// any thread — the mutation hops to the main thread.
fn refresh_tray(app: &AppHandle) {
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        let snap = gather_status();
        if let Some(tray) = app2.tray_by_id(TRAY_ID) {
            if let Ok(menu) = build_tray_menu(&app2, &snap) {
                let _ = tray.set_menu(Some(menu));
            }
            let _ = tray.set_tooltip(Some(format!("Folklore — {}", status_line(&snap))));
        }
    });
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let snap = gather_status();
    let menu = build_tray_menu(app.handle(), &snap)?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip(format!("Folklore — {}", status_line(&snap)))
        .menu(&menu)
        // Left-click the tray icon → toggle the peer-activity island (the menu
        // still opens on right-click / secondary).
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_island(tray.app_handle());
            }
        })
        .on_menu_event(|app, event| match event.id.as_ref() {
            "activity" => toggle_island(app),
            "open" => show_main(app),
            "daemon-toggle" => {
                let app = app.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let running = gather_status()
                        .get("daemon_running")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    let _ = run_cli(&app, &["daemon", if running { "stop" } else { "start" }]);
                    refresh_tray(&app);
                });
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Single instance must register first: a second launch focuses the
        // existing window instead of spawning a duplicate tray + daemon race.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            run_onboard,
            harness_list,
            daemon_start,
            daemon_stop,
            status_snapshot,
            recent_activity
        ])
        // Closing the window hides it — destroying it would make the tray's
        // "Open Folklore" a no-op for the rest of the session.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            build_tray(app)?;
            if let Some(island) = app.get_webview_window("island") {
                style_island(&island);
                let _ = island.set_visible_on_all_workspaces(true);
            }
            spawn_activity_watcher(app.handle().clone());
            // Keep the tray status honest without any window open.
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(10));
                refresh_tray(&handle);
            });
            // First run: no identity yet → open the wizard. Afterwards the app
            // starts quietly in the tray like any menubar utility.
            if !is_onboarded() {
                show_main(app.handle());
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Folklore");
}
