import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { disconnectSocket } from "../services/socket";
import { useI18n } from "../i18n/I18nContext";

interface DashboardProps {
  onLogout: () => void;
  userName: string;
  deviceName: string;
}

export default function Dashboard({ onLogout, userName, deviceName }: DashboardProps) {
  const { t } = useI18n();
  const [showInfo, setShowInfo] = useState(false);

  async function handleLogout() {
    disconnectSocket();
    await invoke("delete_session").catch(() => {});
    onLogout();
  }

  const firstName = userName ? userName.split(" ")[0] : "";

  return (
    <>
      <div className="glass-card card-enter">
        <div className="card-accent" />

        <div className="card-body">
          {/* Welcome section */}
          {firstName && (
            <div className="welcome-section">
              <div className="welcome-avatar">
                {firstName.charAt(0).toUpperCase()}
              </div>
              <div className="welcome-info">
                <p className="welcome-greeting">{t("dash.welcome")}</p>
                <p className="welcome-name">{userName}</p>
              </div>
              {/* Info button - top right */}
              <button className="btn-info-trigger" onClick={() => setShowInfo(true)}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
              </button>
            </div>
          )}

          <div className="status-card">
            <div className="status-header">
              <div className="pulse-ring">
                <div className="pulse-core" />
              </div>
              <span className="status-label">{t("dash.connected")}</span>
            </div>
            <p className="status-detail">{t("dash.statusDetail")}</p>
          </div>

          {/* Device info */}
          {deviceName && (
            <div className="device-info">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
              <span>{deviceName}</span>
            </div>
          )}

          <button className="btn-secondary" onClick={handleLogout}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
            <span>{t("dash.disconnect")}</span>
          </button>
        </div>
      </div>

      {/* Info Modal - slides from top */}
      {showInfo && (
        <div className="info-modal-overlay" onClick={() => setShowInfo(false)}>
          <div className="info-modal" onClick={(e) => e.stopPropagation()}>
            <div className="info-modal-header">
              <div className="info-modal-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
              </div>
              <span>{t("dash.howItWorks")}</span>
              <button className="info-modal-close" onClick={() => setShowInfo(false)}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
            <div className="info-modal-body">
              <div className="info-step">
                <div className="info-step-num">1</div>
                <p>{t("dash.step1")}</p>
              </div>
              <div className="info-step">
                <div className="info-step-num">2</div>
                <p>{t("dash.step2")}</p>
              </div>
              <div className="info-step">
                <div className="info-step-num">3</div>
                <p>{t("dash.step3")}</p>
              </div>
              <div className="info-step">
                <div className="info-step-num">4</div>
                <p>{t("dash.step4")}</p>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
