use serde::{Deserialize, Serialize};
use std::sync::Arc;
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
}

#[derive(Deserialize, Debug)]
struct PuppeteerResponse {
    id: String,
    ok: Option<bool>,
    error: Option<String>,
    cookies: Option<String>,
    #[serde(rename = "pageId")]
    page_id: Option<u64>,
}

/// Find the puppeteer-service.cjs script path
fn find_script_path() -> Result<String, String> {
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

/// Find node binary path
fn find_node_binary() -> String {
    let candidates = [
        "/usr/local/bin/node",
        "/opt/homebrew/bin/node",
        "/usr/bin/node",
        // nvm
        &format!("{}/.nvm/versions/node", std::env::var("HOME").unwrap_or_default()),
    ];

    for c in &candidates {
        if c.contains(".nvm") {
            // Find latest nvm node
            if let Ok(entries) = std::fs::read_dir(c) {
                let mut versions: Vec<_> = entries.filter_map(|e| e.ok()).collect();
                versions.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
                if let Some(v) = versions.first() {
                    let node = v.path().join("bin/node");
                    if node.exists() {
                        return node.to_string_lossy().to_string();
                    }
                }
            }
            continue;
        }
        if std::path::Path::new(c).exists() {
            return c.to_string();
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
async fn ensure_process(state: &mut BrowserState) -> Result<(), String> {
    if state.child.is_some() {
        return Ok(());
    }

    let script_path = find_script_path()?;
    let node_bin = find_node_binary();
    eprintln!("[browser] Starting puppeteer service: {} (node: {})", script_path, node_bin);

    let mut child = Command::new(&node_bin)
        .arg(&script_path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit()) // Puppeteer logs go to Tauri's stderr
        .spawn()
        .map_err(|e| format!("Failed to start puppeteer service: {}", e))?;

    let stdin = child.stdin.take().ok_or("Failed to get stdin")?;
    let stdout = child.stdout.take().ok_or("Failed to get stdout")?;

    // Spawn a background task to read stdout lines into a channel
    let (tx, rx) = tokio::sync::mpsc::channel::<String>(100);
    tokio::spawn(async move {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
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
async fn send_command(state: &mut BrowserState, cmd: PuppeteerCommand) -> Result<PuppeteerResponse, String> {
    ensure_process(state).await?;

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
                    if resp.id == cmd_id || resp.id.starts_with(&cmd_id) {
                        return Ok(resp);
                    }
                }
                // Not our response, continue
            }
            Ok(None) => return Err("Puppeteer process exited".into()),
            Err(_) => return Err("Timeout waiting for puppeteer response".into()),
        }
    }
}

pub async fn launch_and_open_page(
    state: &SharedBrowserState,
    opts: LaunchOptions,
) -> Result<String, String> {
    eprintln!("[browser] launch_and_open_page called: url={}", opts.url);
    let mut guard = state.lock().await;

    guard.next_id += 1;
    let id = format!("cmd_{}", guard.next_id);

    let cmd = PuppeteerCommand {
        id,
        action: "launch".into(),
        url: Some(opts.url),
        proxy: opts.proxy,
        headless: opts.headless,
        user_agent: opts.user_agent,
        username: opts.username,
        password: opts.password,
        cookies: opts.cookies,
        puppeter_config: opts.puppeter_config,
        page_id: None,
    };

    let resp = send_command(&mut guard, cmd).await?;

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
) -> Result<String, String> {
    eprintln!("[browser] launch_and_open_page_cookies called: url={}", opts.url);
    let mut guard = state.lock().await;

    guard.next_id += 1;
    let id = format!("cmd_{}", guard.next_id);

    let cmd = PuppeteerCommand {
        id,
        action: "launchCookies".into(),
        url: Some(opts.url),
        proxy: opts.proxy,
        headless: opts.headless,
        user_agent: opts.user_agent,
        username: opts.username,
        password: opts.password,
        cookies: opts.cookies,
        puppeter_config: opts.puppeter_config,
        page_id: None,
    };

    let resp = send_command(&mut guard, cmd).await?;

    if resp.ok.unwrap_or(false) {
        Ok("Browser and page ready".into())
    } else {
        Err(resp.error.unwrap_or_else(|| "Unknown error".into()))
    }
}

pub async fn get_cookies_from_page(state: &SharedBrowserState) -> Result<Option<String>, String> {
    let mut guard = state.lock().await;

    guard.next_id += 1;
    let id = format!("cmd_{}", guard.next_id);

    let cmd = PuppeteerCommand {
        id,
        action: "getCookies".into(),
        url: None,
        proxy: None,
        headless: None,
        user_agent: None,
        username: None,
        password: None,
        cookies: None,
        puppeter_config: None,
        page_id: None,
    };

    let resp = send_command(&mut guard, cmd).await?;

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

        let cmd = PuppeteerCommand {
            id,
            action: "close".into(),
            url: None,
            proxy: None,
            headless: None,
            user_agent: None,
            username: None,
            password: None,
            cookies: None,
            puppeter_config: None,
            page_id: None,
        };

        // Try to send close command, but don't fail if process is already dead
        let _ = send_command(&mut guard, cmd).await;

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
