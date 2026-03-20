import { invoke } from "@tauri-apps/api/core";
import { disconnectSocket } from "../services/socket";
import { useI18n } from "../i18n/I18nContext";

interface DashboardProps {
  onLogout: () => void;
}

export default function Dashboard({ onLogout }: DashboardProps) {
  const { t } = useI18n();

  async function handleLogout() {
    disconnectSocket();
    await invoke("delete_session").catch(() => {});
    onLogout();
  }

  return (
    <div className="glass-card card-enter">
      <div className="card-accent" />

      <div className="card-body">
        <div className="status-card">
          <div className="status-header">
            <div className="pulse-ring">
              <div className="pulse-core" />
            </div>
            <span className="status-label">{t("dash.connected")}</span>
          </div>
          <p className="status-detail">{t("dash.statusDetail")}</p>
        </div>

        <div className="stats-row">
          <div className="stat-box">
            <div className="stat-value">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
              <span>{t("dash.active")}</span>
            </div>
            <div className="stat-label">{t("dash.session")}</div>
          </div>
          <div className="stat-divider" />
          <div className="stat-box">
            <div className="stat-value">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
              <span>{t("dash.verified")}</span>
            </div>
            <div className="stat-label">{t("dash.device")}</div>
          </div>
          <div className="stat-divider" />
          <div className="stat-box">
            <div className="stat-value">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
              <span>{t("dash.secure")}</span>
            </div>
            <div className="stat-label">{t("dash.channel")}</div>
          </div>
        </div>

        <button className="btn-secondary" onClick={handleLogout}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
          <span>{t("dash.disconnect")}</span>
        </button>
      </div>
    </div>
  );
}
