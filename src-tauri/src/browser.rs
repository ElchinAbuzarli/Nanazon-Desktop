use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

pub struct BrowserState {
    child: Option<Child>,
    stdin: Option<tokio::process::ChildStdin>,
    stdout_lines: Option<Arc<Mutex<tokio::sync::mpsc::Receiver<String>>>>,
    next_id: u64,
}

impl BrowserState {
    pub fn new() -> Self {
        Self {
            child: None,
            stdin: None,
            stdout_lines: None,
            next_id: 0,
        }
    }
}

pub type SharedBrowserState = Arc<Mutex<BrowserState>>;

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LaunchOptions {
    pub url: String,
    pub proxy: Option<String>,
    pub headless: Option<bool>,
    pub user_agent: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub cookies: Option<String>,
    pub puppeter_config: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PuppeteerCommand {
    id: String,
    action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    proxy: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    headless: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    user_agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    password: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cookies: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    puppeter_config: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    page_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    packages: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    user_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    force: Option<bool>,
}

#[derive(Deserialize, Debug)]
struct PuppeteerResponse {
    id: Option<String>,
    ok: Option<bool>,
    error: Option<String>,
    cookies: Option<String>,
    #[serde(rename = "pageId")]
    page_id: Option<u64>,
    // Event fields (used during deserialization routing, not read directly)
    #[allow(dead_code)]
    event: Option<String>,
}

/// Find the puppeteer-service.cjs script path
fn find_script_path() -> Result<String, String> {
    // In dev mode, prefer the source file if it exists
    let src_name = "puppeteer-service.src.cjs";
    let dev_src_path = std::path::Path::new("../scripts").join(src_name);
    if dev_src_path.exists() {
        return Ok(dev_src_path.canonicalize().unwrap().to_string_lossy().to_string());
    }

    let script_name = "puppeteer-service.cjs";

    // 1) Dev mode: relative to src-tauri
    let dev_path = std::path::Path::new("../scripts").join(script_name);
    if dev_path.exists() {
        return Ok(dev_path.canonicalize().unwrap().to_string_lossy().to_string());
    }

    // 2) Relative to current exe (Windows build, Linux)
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            // Direct next to exe
            let p = exe_dir.join("scripts").join(script_name);
            if p.exists() {
                return Ok(p.to_string_lossy().to_string());
            }
            // macOS .app bundle: exe is in .app/Contents/MacOS/, resources in .app/Contents/Resources/
            let p = exe_dir.join("../Resources/scripts").join(script_name);
            if p.exists() {
                return Ok(p.canonicalize().unwrap().to_string_lossy().to_string());
            }
            // Tauri bundles "../scripts/*" as "_up_/scripts/*" in Resources
            let p = exe_dir.join("../Resources/_up_/scripts").join(script_name);
            if p.exists() {
                return Ok(p.canonicalize().unwrap().to_string_lossy().to_string());
            }
        }
    }

    Err("puppeteer-service.cjs not found".into())
}

/// Find node binary path — prefer bundled node, then system node
fn find_node_binary() -> String {
    // 1) Check bundled node binary (inside the app bundle)
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let bundled_paths = [
                // macOS .app bundle: Contents/MacOS/../Resources/_up_/binaries/node
                exe_dir.join("../Resources/_up_/binaries/node"),
                exe_dir.join("../Resources/binaries/node"),
                // Windows/Linux: next to exe
                exe_dir.join("binaries/node.exe"),
                exe_dir.join("binaries/node"),
            ];

            for p in &bundled_paths {
                if p.exists() {
                    if let Ok(canonical) = p.canonicalize() {
                        eprintln!("[browser] Using bundled node: {}", canonical.display());
                        return canonical.to_string_lossy().to_string();
                    }
                }
            }
        }
    }

    // 2) Dev mode: check ../binaries/node relative to src-tauri
    let dev_path = std::path::Path::new("../binaries/node");
    if dev_path.exists() {
        if let Ok(canonical) = dev_path.canonicalize() {
            eprintln!("[browser] Using dev bundled node: {}", canonical.display());
            return canonical.to_string_lossy().to_string();
        }
    }

    // 3) Fall back to system-installed node
    let candidates = [
        "/usr/local/bin/node",
        "/opt/homebrew/bin/node",
        "/usr/bin/node",
    ];

    for c in &candidates {
        if std::path::Path::new(c).exists() {
            return c.to_string();
        }
    }

    // nvm
    let home = std::env::var("HOME").unwrap_or_default();
    let nvm_dir = format!("{}/.nvm/versions/node", home);
    if let Ok(entries) = std::fs::read_dir(&nvm_dir) {
        let mut versions: Vec<_> = entries.filter_map(|e| e.ok()).collect();
        versions.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
        if let Some(v) = versions.first() {
            let node = v.path().join("bin/node");
            if node.exists() {
                return node.to_string_lossy().to_string();
            }
        }
    }

    // Try PATH-based which
    if let Ok(output) = std::process::Command::new("which").arg("node").output() {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                return path;
            }
        }
    }

    "node".to_string()
}

/// Ensure the puppeteer child process is running
async fn ensure_process(state: &mut BrowserState, app_handle: Option<tauri::AppHandle>) -> Result<(), String> {
    if state.child.is_some() {
        return Ok(());
    }

    let script_path = find_script_path()?;
    let node_bin = find_node_binary();
    eprintln!("[browser] Starting puppeteer service: {} (node: {})", script_path, node_bin);

    // Set cwd to the directory containing the script so require() can find node_modules
    let script_dir = std::path::Path::new(&script_path)
        .parent()
        .and_then(|p| p.parent()) // go up from scripts/ to project root
        .unwrap_or(std::path::Path::new("."));

    let mut child = Command::new(&node_bin)
        .arg(&script_path)
        .current_dir(script_dir)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit()) // Puppeteer logs go to Tauri's stderr
        .spawn()
        .map_err(|e| format!("Failed to start puppeteer service: {}", e))?;

    let stdin = child.stdin.take().ok_or("Failed to get stdin")?;
    let stdout = child.stdout.take().ok_or("Failed to get stdout")?;

    // Channel for command responses (lines with "id" field)
    let (tx, rx) = tokio::sync::mpsc::channel::<String>(100);

    // Spawn a background task to read stdout lines and route them
    tokio::spawn(async move {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            // Check if this is an event (has "event" field) or a command response (has "id" field)
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&line) {
                if parsed.get("event").is_some() {
                    // This is an event from puppeteer — forward to Tauri frontend
                    if let Some(ref handle) = app_handle {
                        let event_name = parsed["event"].as_str().unwrap_or("unknown");
                        let tauri_event = format!("puppeteer-{}", event_name);
                        let _ = handle.emit(&tauri_event, parsed.clone());
                    }
                    continue;
                }
            }
            // Command response — send to channel
            if tx.send(line).await.is_err() {
                break;
            }
        }
    });

    state.child = Some(child);
    state.stdin = Some(stdin);
    state.stdout_lines = Some(Arc::new(Mutex::new(rx)));

    eprintln!("[browser] Puppeteer service started");
    Ok(())
}

/// Send a command to puppeteer and wait for matching response
async fn send_command(state: &mut BrowserState, cmd: PuppeteerCommand, app_handle: Option<tauri::AppHandle>) -> Result<PuppeteerResponse, String> {
    ensure_process(state, app_handle).await?;

    let cmd_id = cmd.id.clone();
    let json = serde_json::to_string(&cmd).map_err(|e| e.to_string())?;
    eprintln!("[browser] Sending command: {}", json);

    let stdin = state.stdin.as_mut().ok_or("No stdin available")?;
    stdin
        .write_all(format!("{}\n", json).as_bytes())
        .await
        .map_err(|e| format!("Failed to write to puppeteer: {}", e))?;
    stdin
        .flush()
        .await
        .map_err(|e| format!("Failed to flush stdin: {}", e))?;

    // Wait for the response with matching id
    let rx_arc = state.stdout_lines.as_ref().ok_or("No stdout reader")?.clone();
    let mut rx = rx_arc.lock().await;

    // Read lines until we find our response (with timeout)
    let timeout = tokio::time::Duration::from_secs(60);
    loop {
        match tokio::time::timeout(timeout, rx.recv()).await {
            Ok(Some(line)) => {
                if let Ok(resp) = serde_json::from_str::<PuppeteerResponse>(&line) {
                    if let Some(ref resp_id) = resp.id {
                        if resp_id == &cmd_id || resp_id.starts_with(&cmd_id) {
                            return Ok(resp);
                        }
                    }
                }
                // Not our response, continue
            }
            Ok(None) => return Err("Puppeteer process exited".into()),
            Err(_) => return Err("Timeout waiting for puppeteer response".into()),
        }
    }
}

fn make_cmd(id: String, action: &str) -> PuppeteerCommand {
    PuppeteerCommand {
        id,
        action: action.into(),
        url: None,
        proxy: None,
        headless: None,
        user_agent: None,
        username: None,
        password: None,
        cookies: None,
        puppeter_config: None,
        page_id: None,
        packages: None,
        token: None,
        user_id: None,
        force: None,
    }
}

pub async fn launch_and_open_page(
    state: &SharedBrowserState,
    opts: LaunchOptions,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    eprintln!("[browser] launch_and_open_page called: url={}", opts.url);
    let mut guard = state.lock().await;

    guard.next_id += 1;
    let id = format!("cmd_{}", guard.next_id);

    let mut cmd = make_cmd(id, "launch");
    cmd.url = Some(opts.url);
    cmd.proxy = opts.proxy;
    cmd.headless = opts.headless;
    cmd.user_agent = opts.user_agent;
    cmd.username = opts.username;
    cmd.password = opts.password;
    cmd.cookies = opts.cookies;
    cmd.puppeter_config = opts.puppeter_config;

    let resp = send_command(&mut guard, cmd, Some(app_handle)).await?;

    if resp.ok.unwrap_or(false) {
        eprintln!("[browser] Page opened successfully, pageId={:?}", resp.page_id);
        Ok("Browser and page ready".into())
    } else {
        Err(resp.error.unwrap_or_else(|| "Unknown error".into()))
    }
}

pub async fn launch_and_open_page_cookies(
    state: &SharedBrowserState,
    opts: LaunchOptions,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    eprintln!("[browser] launch_and_open_page_cookies called: url={}", opts.url);
    let mut guard = state.lock().await;

    guard.next_id += 1;
    let id = format!("cmd_{}", guard.next_id);

    let mut cmd = make_cmd(id, "launchCookies");
    cmd.url = Some(opts.url);
    cmd.proxy = opts.proxy;
    cmd.headless = opts.headless;
    cmd.user_agent = opts.user_agent;
    cmd.username = opts.username;
    cmd.password = opts.password;
    cmd.cookies = opts.cookies;
    cmd.puppeter_config = opts.puppeter_config;

    let resp = send_command(&mut guard, cmd, Some(app_handle)).await?;

    if resp.ok.unwrap_or(false) {
        Ok("Browser and page ready".into())
    } else {
        Err(resp.error.unwrap_or_else(|| "Unknown error".into()))
    }
}

pub async fn get_cookies_from_page(state: &SharedBrowserState, app_handle: tauri::AppHandle) -> Result<Option<String>, String> {
    let mut guard = state.lock().await;

    guard.next_id += 1;
    let id = format!("cmd_{}", guard.next_id);

    let cmd = make_cmd(id, "getCookies");
    let resp = send_command(&mut guard, cmd, Some(app_handle)).await?;

    if resp.ok.unwrap_or(false) {
        Ok(resp.cookies)
    } else {
        Err(resp.error.unwrap_or_else(|| "Unknown error".into()))
    }
}

pub async fn close_browser(state: &SharedBrowserState) -> Result<String, String> {
    let mut guard = state.lock().await;

    if guard.child.is_some() {
        guard.next_id += 1;
        let id = format!("cmd_{}", guard.next_id);

        let cmd = make_cmd(id, "close");

        // Try to send close command, but don't fail if process is already dead
        let _ = send_command(&mut guard, cmd, None).await;

        // Kill the child process
        if let Some(ref mut child) = guard.child {
            let _ = child.kill().await;
        }
        guard.child = None;
        guard.stdin = None;
        guard.stdout_lines = None;
    }

    Ok("Browser closed".into())
}

pub async fn set_auth(
    state: &SharedBrowserState,
    auth_token: String,
    auth_user_id: String,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let mut guard = state.lock().await;

    if guard.child.is_none() {
        return Ok("No puppeteer process running".into());
    }

    guard.next_id += 1;
    let id = format!("cmd_{}", guard.next_id);

    let mut cmd = make_cmd(id, "setAuth");
    cmd.token = Some(auth_token);
    cmd.user_id = Some(auth_user_id);

    let resp = send_command(&mut guard, cmd, Some(app_handle)).await?;

    if resp.ok.unwrap_or(false) {
        Ok("Auth updated".into())
    } else {
        Err(resp.error.unwrap_or_else(|| "Unknown error".into()))
    }
}

pub async fn set_download_packages(
    state: &SharedBrowserState,
    packages: serde_json::Value,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let mut guard = state.lock().await;

    // Only send if subprocess is running
    if guard.child.is_none() {
        return Ok("No puppeteer process running, packages will be sent on next launch".into());
    }

    guard.next_id += 1;
    let id = format!("cmd_{}", guard.next_id);

    let mut cmd = make_cmd(id, "setPackages");
    cmd.packages = Some(packages);

    let resp = send_command(&mut guard, cmd, Some(app_handle)).await?;

    if resp.ok.unwrap_or(false) {
        Ok("Packages updated".into())
    } else {
        Err(resp.error.unwrap_or_else(|| "Unknown error".into()))
    }
}
