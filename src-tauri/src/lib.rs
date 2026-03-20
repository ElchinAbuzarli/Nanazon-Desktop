mod browser;

use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, BlockEncryptMut, KeyIvInit};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use sysinfo::System;
use tauri::Manager;
use tokio::sync::Mutex;

type Aes256CbcEnc = cbc::Encryptor<aes::Aes256>;
type Aes256CbcDec = cbc::Decryptor<aes::Aes256>;

const CRYPTO_SECRET: &str = "benimsüpergüçlükodum123";

fn get_encryption_key() -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(CRYPTO_SECRET.as_bytes());
    let result = hasher.finalize();
    let mut key = [0u8; 32];
    key.copy_from_slice(&result);
    key
}

fn get_data_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("com.nanazon.app")
}

fn ensure_data_dir() {
    let dir = get_data_dir();
    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
    }
}

fn encrypt_string(text: &str) -> String {
    let key = get_encryption_key();
    let mut iv = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut iv);

    let plaintext = text.as_bytes();
    // Buffer needs to be large enough for plaintext + padding
    let mut buf = vec![0u8; plaintext.len() + 16];
    buf[..plaintext.len()].copy_from_slice(plaintext);

    let ct = Aes256CbcEnc::new(&key.into(), &iv.into())
        .encrypt_padded_mut::<Pkcs7>(&mut buf, plaintext.len())
        .unwrap();

    format!("{}:{}", hex::encode(iv), hex::encode(ct))
}

fn decrypt_string(text: &str) -> Result<String, String> {
    let key = get_encryption_key();
    let parts: Vec<&str> = text.splitn(2, ':').collect();
    if parts.len() != 2 {
        return Err("Invalid encrypted format".to_string());
    }

    let iv = hex::decode(parts[0]).map_err(|e| e.to_string())?;
    let ct = hex::decode(parts[1]).map_err(|e| e.to_string())?;

    let mut buf = ct.clone();
    let iv_arr: [u8; 16] = iv.try_into().map_err(|_| "Invalid IV length")?;

    let pt = Aes256CbcDec::new(&key.into(), &iv_arr.into())
        .decrypt_padded_mut::<Pkcs7>(&mut buf)
        .map_err(|e| e.to_string())?;

    String::from_utf8(pt.to_vec()).map_err(|e| e.to_string())
}

#[derive(Serialize, Deserialize, Clone)]
pub struct DeviceInfo {
    pub uid: String,
    pub device_name: String,
    pub os: String,
    pub cpu: String,
    pub cores: usize,
    pub ram: String,
    pub app_version: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct SessionData {
    pub token: String,
    #[serde(rename = "userId")]
    pub user_id: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Credentials {
    pub email: String,
    pub password: String,
}

#[tauri::command]
fn get_device_info() -> DeviceInfo {
    let mut sys = System::new_all();
    sys.refresh_all();

    let total_ram = sys.total_memory() as f64 / 1024.0 / 1024.0 / 1024.0;

    let cpu_name = sys
        .cpus()
        .first()
        .map(|c| c.brand().to_string())
        .unwrap_or_else(|| "Unknown".to_string());

    let core_count = sys.cpus().len();

    let os_name = System::name().unwrap_or_else(|| "Unknown".to_string());
    let os_version = System::os_version().unwrap_or_else(|| "".to_string());

    let device_name = hostname::get()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_else(|_| "Unknown".to_string());

    // Use a simple machine fingerprint based on hostname + cpu + ram
    let mut hasher = Sha256::new();
    hasher.update(device_name.as_bytes());
    hasher.update(cpu_name.as_bytes());
    hasher.update(format!("{}", sys.total_memory()).as_bytes());
    let uid = format!("{:x}", hasher.finalize());
    let uid_short = &uid[..32];

    DeviceInfo {
        uid: uid_short.to_string(),
        device_name,
        os: format!("{} {}", os_name, os_version),
        cpu: cpu_name,
        cores: core_count,
        ram: format!("{:.2} GB", total_ram),
        app_version: "0.1.0".to_string(),
    }
}

#[tauri::command]
fn save_session(token: String, user_id: String) -> Result<(), String> {
    ensure_data_dir();
    let session = SessionData {
        token,
        user_id,
    };
    let json = serde_json::to_string(&session).map_err(|e| e.to_string())?;
    let encrypted = encrypt_string(&json);
    let path = get_data_dir().join("session.json");
    fs::write(path, encrypted).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_session() -> Result<Option<SessionData>, String> {
    let path = get_data_dir().join("session.json");
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let decrypted = decrypt_string(&content)?;
    let session: SessionData = serde_json::from_str(&decrypted).map_err(|e| e.to_string())?;
    Ok(Some(session))
}

#[tauri::command]
fn delete_session() -> Result<(), String> {
    let path = get_data_dir().join("session.json");
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn save_credentials(email: String, password: String) -> Result<(), String> {
    ensure_data_dir();
    let creds = Credentials { email, password };
    let json = serde_json::to_string(&creds).map_err(|e| e.to_string())?;
    let encrypted = encrypt_string(&json);
    let path = get_data_dir().join("credentials.json");
    fs::write(path, encrypted).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_credentials() -> Result<Option<Credentials>, String> {
    let path = get_data_dir().join("credentials.json");
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let decrypted = decrypt_string(&content)?;
    let creds: Credentials = serde_json::from_str(&decrypted).map_err(|e| e.to_string())?;
    Ok(Some(creds))
}

#[tauri::command]
fn save_language(lang: String) -> Result<(), String> {
    ensure_data_dir();
    let path = get_data_dir().join("language.txt");
    fs::write(path, lang).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_language() -> Result<Option<String>, String> {
    let path = get_data_dir().join("language.txt");
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    Ok(Some(content.trim().to_string()))
}

// --- Browser automation commands ---

#[tauri::command]
async fn launch_browser(
    state: tauri::State<'_, Arc<Mutex<browser::BrowserState>>>,
    url: String,
    proxy: Option<String>,
    headless: Option<bool>,
    user_agent: Option<String>,
    username: Option<String>,
    password: Option<String>,
    cookies: Option<String>,
    puppeter_config: Option<String>,
) -> Result<String, String> {
    let opts = browser::LaunchOptions {
        url,
        proxy,
        headless,
        user_agent,
        username,
        password,
        cookies,
        puppeter_config,
    };
    browser::launch_and_open_page(&state, opts).await
}

#[tauri::command]
async fn launch_browser_cookies(
    state: tauri::State<'_, Arc<Mutex<browser::BrowserState>>>,
    url: String,
    proxy: Option<String>,
    headless: Option<bool>,
    user_agent: Option<String>,
    username: Option<String>,
    password: Option<String>,
    cookies: Option<String>,
    puppeter_config: Option<String>,
) -> Result<String, String> {
    let opts = browser::LaunchOptions {
        url,
        proxy,
        headless,
        user_agent,
        username,
        password,
        cookies,
        puppeter_config,
    };
    browser::launch_and_open_page_cookies(&state, opts).await
}

#[tauri::command]
async fn get_browser_cookies(
    state: tauri::State<'_, Arc<Mutex<browser::BrowserState>>>,
) -> Result<Option<String>, String> {
    browser::get_cookies_from_page(&state).await
}

#[tauri::command]
async fn close_browser(
    state: tauri::State<'_, Arc<Mutex<browser::BrowserState>>>,
) -> Result<String, String> {
    browser::close_browser(&state).await
}

#[tauri::command]
fn minimize_to_tray(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let browser_state: Arc<Mutex<browser::BrowserState>> =
        Arc::new(Mutex::new(browser::BrowserState::new()));

    tauri::Builder::default()
        .manage(browser_state)
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            // Create system tray
            let _tray = tauri::tray::TrayIconBuilder::new()
                .tooltip("Nanazon Share")
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click { .. } = event {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_device_info,
            save_session,
            load_session,
            delete_session,
            save_credentials,
            load_credentials,
            save_language,
            load_language,
            minimize_to_tray,
            launch_browser,
            launch_browser_cookies,
            get_browser_cookies,
            close_browser,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
