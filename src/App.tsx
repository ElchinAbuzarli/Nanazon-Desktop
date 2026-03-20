import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { jwtDecode } from "jwt-decode";
import { I18nProvider, useI18n, getT } from "./i18n/I18nContext";
import Login, { initializeSocketListeners } from "./components/Login";
import Dashboard from "./components/Dashboard";
import Toast, { showToast } from "./components/Toast";
import LanguageSwitcher from "./components/LanguageSwitcher";
import { connectSocketWithToken, listen, sendHandshake, disconnectSocket, getUserName, getUserRole } from "./services/socket";
import "./App.css";

type Page = "loading" | "login" | "dashboard";

function AppInner() {
  const [page, setPage] = useState<Page>("loading");
  const [userInfo, setUserInfo] = useState<{ name: string; device: string }>({ name: "", device: "" });
  // useI18n() called to keep getT() in sync with current language
  useI18n();

  useEffect(() => {
    restoreSession();
  }, []);

  async function restoreSession() {
    try {
      const session = await invoke<{ token: string; userId: string } | null>("load_session");
      if (!session) {
        setPage("login");
        return;
      }

      const decoded: { exp: number } = jwtDecode(session.token);
      const expiryTime = decoded.exp * 1000;
      const now = Date.now();

      if (expiryTime < now) {
        showToast(getT()("session.expired"), getT()("session.expiredMsg"));
        await invoke("delete_session");
        setPage("login");
        return;
      }

      await connectSocketWithToken(session.token, session.userId);

      initializeSocketListeners(() => {
        setPage("login");
      });

      listen("downloadStatus", (data: { packages: any[] }) => {
        console.log("[socket] Download status:", data.packages?.length, "packages");
      });

      await sendHandshake("startup");
      // Get device info for display
      try {
        const deviceInfo = await invoke<{ device_name: string }>("get_device_info");
        setUserInfo({ name: getUserName() || "", device: deviceInfo?.device_name || "" });
      } catch { /* ignore */ }
      showToast(getT()("session.autoLogin"), getT()("login.connectionActive"));
      setPage("dashboard");
    } catch (err) {
      console.warn("Session restore failed:", err);
      await invoke("delete_session").catch(() => {});
      setPage("login");
    }
  }

  function handleMinimize() {
    invoke("minimize_to_tray").catch(() => {});
  }

  async function handleLoginSuccess(_token: string, _userId: string) {
    try {
      const deviceInfo = await invoke<{ device_name: string }>("get_device_info");
      setUserInfo({ name: getUserName() || "", device: deviceInfo?.device_name || "" });
    } catch { /* ignore */ }
    setPage("dashboard");
  }

  function handleLogout() {
    disconnectSocket();
    invoke("delete_session").catch(() => {});
    setPage("login");
  }

  return (
    <div className="app-shell">
      {/* Animated aurora background */}
      <div className="aurora">
        <div className="aurora-band aurora-band-1" />
        <div className="aurora-band aurora-band-2" />
        <div className="aurora-band aurora-band-3" />
      </div>

      {/* Floating orbs */}
      <div className="orb orb-1" />
      <div className="orb orb-2" />
      <div className="orb orb-3" />
      <div className="orb orb-4" />
      <div className="orb orb-5" />

      {/* Noise texture overlay */}
      <div className="noise-overlay" />

      {/* Language switcher - top left */}
      <LanguageSwitcher />

      {/* Window controls - top right */}
      <div className="window-controls">
        <button className="win-btn win-minimize" onClick={handleMinimize} />
      </div>

      {/* Main content */}
      <div className="scene">
        {/* Logo - above glass card */}
        <div className="app-logo">
          <img src="/images/logo_guncel.png" alt="Nanazon" className="app-logo-img" />
        </div>
        {page === "loading" && (
          <div className="spinner-wrap">
            <div className="spinner">
              <div className="spinner-ring" />
              <div className="spinner-ring" />
              <div className="spinner-dot" />
            </div>
          </div>
        )}
        {page === "login" && (
          <Login onLoginSuccess={handleLoginSuccess} />
        )}
        {page === "dashboard" && (
          <Dashboard onLogout={handleLogout} userName={userInfo.name} deviceName={userInfo.device} />
        )}
      </div>

      <Toast />
    </div>
  );
}

export default function App() {
  return (
    <I18nProvider>
      <AppInner />
    </I18nProvider>
  );
}
