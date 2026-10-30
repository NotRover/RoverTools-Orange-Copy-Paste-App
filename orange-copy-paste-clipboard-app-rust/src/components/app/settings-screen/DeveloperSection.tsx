import React, { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { IconCode, IconRefresh } from "@tabler/icons-react";
import { NAVIGATE_EVENT } from "../../../types";
import type {
  BackendProfile,
  BackendTestReport,
  DevConfig,
  DevConnectionStatus,
  Discovered,
  SyncQuota,
} from "../../../types";
import { ChangedMark } from "./ChangedMark";
import "./DeveloperSection.css";

// ── Helpers ───────────────────────────────────────────────────────────

const errorText = (e: unknown) =>
  typeof e === "string" ? e : e instanceof Error ? e.message : String(e);

const formatBytes = (n: number) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

const formatTime = (ms: number | null | undefined) =>
  ms == null ? "-" : new Date(ms).toLocaleString();

const ago = (ms: number | null | undefined) => {
  if (ms == null) return "-";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

const sameProfile = (a: BackendProfile, b: BackendProfile) =>
  a.server_url === b.server_url &&
  a.supabase_url === b.supabase_url &&
  a.supabase_anon_key === b.supabase_anon_key &&
  a.reset_page_url === b.reset_page_url &&
  a.allow_private_http === b.allow_private_http &&
  a.server_cert_sha256 === b.server_cert_sha256;

const Field: React.FC<{
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  mono?: boolean;
  hint?: string;
}> = ({ label, value, onChange, placeholder, disabled, mono, hint }) => (
  <label className="dev-field">
    <span className="dev-field-label">{label}</span>
    <input
      className={`dev-input${mono ? " dev-input--mono" : ""}`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
    />
    {hint && <span className="dev-field-hint">{hint}</span>}
  </label>
);

const Stat: React.FC<{ label: string; value: React.ReactNode; mono?: boolean }> = ({
  label,
  value,
  mono,
}) => (
  <div className="dev-stat">
    <span className="dev-stat-label">{label}</span>
    <span className={`dev-stat-value${mono ? " dev-stat-value--mono" : ""}`}>{value}</span>
  </div>
);

// ── Section ───────────────────────────────────────────────────────────

/**
 * The Developer group: the switch first, and the tools under it once it is on.
 * The switch row is rendered by the Settings screen (it owns the setting and
 * the confirmation), and handed in here so it sits inside this section.
 */
const DeveloperSection: React.FC<{
  enabled: boolean;
  toggle: React.ReactNode;
  /** Whether a custom server or an update feed is set, for the page list's mark. */
  onChanged: (changed: boolean) => void;
}> = ({ enabled, toggle, onChanged }) => (
  <section className="set-section dev-section" id="set-developer">
    <div className="set-section-head">
      <span className="set-section-icon"><IconCode size={15} /></span>
      <h3 className="set-section-title">Developer</h3>
    </div>
    <div className="set-group">{toggle}</div>
    {enabled && <DeveloperTools onChanged={onChanged} />}
  </section>
);

/** The backend profile, the connection panel and the update feed. */
const DeveloperTools: React.FC<{ onChanged: (changed: boolean) => void }> = ({ onChanged }) => {
  const [config, setConfig] = useState<DevConfig | null>(null);
  const [draft, setDraft] = useState<BackendProfile | null>(null);
  const [busy, setBusy] = useState<"discover" | "test" | "save" | "reset" | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "err" | "info"; text: string } | null>(
    null,
  );
  const [report, setReport] = useState<BackendTestReport | null>(null);

  const [status, setStatus] = useState<DevConnectionStatus | null>(null);
  const [quota, setQuota] = useState<SyncQuota | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);

  const [feedUrl, setFeedUrl] = useState("");
  const [pubkey, setPubkey] = useState("");
  const [feedNotice, setFeedNotice] = useState<string | null>(null);
  const [feedBusy, setFeedBusy] = useState(false);

  const applyConfig = useCallback((c: DevConfig) => {
    setConfig(c);
    setDraft({ ...c.profile });
    setFeedUrl(c.update_feed_url);
    setPubkey(c.update_pubkey);
  }, []);

  const loadConfig = useCallback(() => {
    invoke<DevConfig>("dev_get_config").then(applyConfig).catch(() => {});
  }, [applyConfig]);

  useEffect(() => {
    loadConfig();
    const unlisteners = [
      "sync:signed-out",
      "sync:session-restored",
      "sync:status-changed",
    ].map((name) => listen(name, loadConfig));
    return () => {
      unlisteners.forEach((p) => p.then((un) => un()));
    };
  }, [loadConfig]);

  const refreshStatus = useCallback(async () => {
    setStatusBusy(true);
    setStatusError(null);
    try {
      const s = await invoke<DevConnectionStatus>("dev_connection_status");
      setStatus(s);
      if (s.signed_in) {
        invoke<SyncQuota>("sync_get_quota")
          .then(setQuota)
          .catch(() => setQuota(null));
      } else {
        setQuota(null);
      }
    } catch (e) {
      setStatusError(errorText(e));
    } finally {
      setStatusBusy(false);
    }
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    if (config) onChanged(!config.is_official || config.update_feed_url !== "");
  }, [config, onChanged]);

  if (!config || !draft) return null;

  const locked = config.signed_in;
  const dirty = !sameProfile(draft, config.profile);
  const update = (patch: Partial<BackendProfile>) => {
    setDraft({ ...draft, ...patch });
    setNotice(null);
  };

  const discover = async () => {
    setBusy("discover");
    setNotice(null);
    setReport(null);
    try {
      const d = await invoke<Discovered>("dev_discover", {
        serverUrl: draft.server_url,
        allowPrivateHttp: draft.allow_private_http,
        serverCertSha256: draft.server_cert_sha256,
      });
      const missing: string[] = [];
      if (!d.supabase_url) missing.push("Supabase URL");
      if (!d.supabase_anon_key) missing.push("publishable key");
      setDraft({
        ...draft,
        server_url: draft.server_url.trim().replace(/\/+$/, ""),
        supabase_url: d.supabase_url || draft.supabase_url,
        supabase_anon_key: d.supabase_anon_key || draft.supabase_anon_key,
        reset_page_url: d.reset_page_url || draft.reset_page_url,
      });
      setNotice({
        kind: missing.length ? "info" : "ok",
        text: missing.length
          ? `Server ${d.service_version} answered, but did not provide its ${missing.join(" or ")}. Enter it by hand.`
          : `Server ${d.service_version} (API ${d.api_version}) filled in the rest.`,
      });
    } catch (e) {
      setNotice({ kind: "err", text: errorText(e) });
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy("test");
    setNotice(null);
    setReport(null);
    try {
      const r = await invoke<BackendTestReport>("dev_test_backend", { profile: draft });
      setReport(r);
    } catch (e) {
      setNotice({ kind: "err", text: errorText(e) });
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setBusy("save");
    setNotice(null);
    try {
      const c = await invoke<DevConfig>("dev_set_backend", { profile: draft });
      applyConfig(c);
      setReport(null);
      setNotice({ kind: "ok", text: "Saved. The next sign-in uses this server." });
      refreshStatus();
    } catch (e) {
      setNotice({ kind: "err", text: errorText(e) });
    } finally {
      setBusy(null);
    }
  };

  const reset = async () => {
    setBusy("reset");
    setNotice(null);
    try {
      const c = await invoke<DevConfig>("dev_reset_backend");
      applyConfig(c);
      setReport(null);
      setNotice({ kind: "ok", text: "Back on the official server." });
      refreshStatus();
    } catch (e) {
      setNotice({ kind: "err", text: errorText(e) });
    } finally {
      setBusy(null);
    }
  };

  const pinFromReport = () => {
    if (report?.cert) update({ server_cert_sha256: report.cert.sha256 });
  };

  const saveFeed = async () => {
    setFeedBusy(true);
    setFeedNotice(null);
    try {
      const c = await invoke<DevConfig>("dev_set_update_override", { feedUrl, pubkey });
      applyConfig(c);
      setFeedNotice(
        c.update_feed_url
          ? "Saved. Check now in Updates reads the custom feed."
          : "Saved. Updates come from the official feeds again.",
      );
    } catch (e) {
      setFeedNotice(errorText(e));
    } finally {
      setFeedBusy(false);
    }
  };

  const feedDirty = feedUrl !== config.update_feed_url || pubkey !== config.update_pubkey;

  return (
    <>
      {/* ── Backend ── */}
      <div className="set-group">
        <div className="set-row set-row--stack">
          <div className="set-row-header">
            <div className="set-row-info">
              <span className="set-row-label">
                Backend{config.is_official ? " (official)" : " (custom)"}
                <ChangedMark show={!config.is_official} />
              </span>
              <span className="set-row-desc">
                Point this install at your own server. Enter its URL and press Discover to
                fetch the rest, then Test connection before you save.
              </span>
            </div>
          </div>

          {locked ? (
            <div className="dev-gate">
              <span className="set-row-desc set-row-desc--warn">
                Sign out before changing the server. Your session, device record and keys
                belong to the one you are signed in to.
              </span>
              <button
                type="button"
                className="settings-action-btn"
                onClick={() => window.dispatchEvent(new CustomEvent(NAVIGATE_EVENT, { detail: "account" }))}
              >
                Open Account
              </button>
            </div>
          ) : (
          <>
          <div className="dev-form">
            <Field
              label="Server URL"
              value={draft.server_url}
              onChange={(v) => update({ server_url: v })}
              placeholder="https://sync.example.com"
              mono
            />
            <div className="dev-actions">
              <button
                type="button"
                className="settings-action-btn"
                onClick={discover}
                disabled={busy !== null || !draft.server_url.trim()}
              >
                {busy === "discover" ? "Asking..." : "Discover"}
              </button>
            </div>
            <Field
              label="Supabase URL"
              value={draft.supabase_url}
              onChange={(v) => update({ supabase_url: v })}
              placeholder="https://xxxx.supabase.co"
              mono
            />
            <Field
              label="Supabase publishable key"
              value={draft.supabase_anon_key}
              onChange={(v) => update({ supabase_anon_key: v })}
              placeholder="sb_publishable_..."
              mono
              hint="The public anon key, never the service role key."
            />
            <Field
              label="Password reset page"
              value={draft.reset_page_url}
              onChange={(v) => update({ reset_page_url: v })}
              placeholder="https://your-site/reset"
              mono
              hint="Where a reset email sends the user. Leave empty to keep the official page."
            />
            <label className="dev-check">
              <input
                type="checkbox"
                checked={draft.allow_private_http}
                onChange={(e) => update({ allow_private_http: e.target.checked })}
                />
              <span>
                Allow plain http on private networks
                <span className="dev-field-hint">
                  Lets the server and Supabase URLs use http:// to a LAN, Tailscale or
                  .local address. Everything on that network can read the traffic. Public
                  hosts still need https.
                </span>
              </span>
            </label>
            <Field
              label="Pinned server certificate (SHA-256)"
              value={draft.server_cert_sha256}
              onChange={(v) => update({ server_cert_sha256: v })}
              placeholder="64 hex digits, or empty"
              mono
              hint="For a self-signed certificate. Test connection shows the fingerprint it saw; the pin applies to the server URL only."
            />
          </div>

          {notice && <div className={`dev-notice dev-notice--${notice.kind}`}>{notice.text}</div>}

          {report && (
            <div className={`dev-report${report.ok ? " dev-report--ok" : ""}`}>
              <div className="dev-report-head">
                {report.ok ? "All checks passed" : "Some checks failed"}
                {report.rtt_ms != null && <span className="dev-report-rtt">{report.rtt_ms} ms</span>}
              </div>
              <ul className="dev-report-list">
                {report.steps.map((s) => (
                  <li key={s.name} className={s.ok ? "ok" : "fail"}>
                    <span className="dev-report-name">{s.name}</span>
                    <span className="dev-report-detail">{s.detail}</span>
                  </li>
                ))}
              </ul>
              {report.cert && (
                <div className="dev-report-cert">
                  <span>
                    Certificate SHA-256: <code>{report.cert.sha256}</code>
                    {report.cert.matched_pin
                      ? " (matches the pin)"
                      : report.cert.trusted_by_roots
                        ? " (trusted by the public roots)"
                        : " (not trusted)"}
                  </span>
                  {!report.cert.matched_pin && (
                    <button type="button" className="dev-link-btn" onClick={pinFromReport}>
                      Use as pin
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="dev-actions dev-actions--end">
            <button
              type="button"
              className="settings-action-btn"
              onClick={test}
              disabled={busy !== null}
            >
              {busy === "test" ? "Testing..." : "Test connection"}
            </button>
            <button
              type="button"
              className="settings-action-btn"
              onClick={reset}
              disabled={busy !== null || config.is_official}
            >
              {busy === "reset" ? "Resetting..." : "Reset to official"}
            </button>
            <button
              type="button"
              className="settings-action-btn dev-primary"
              onClick={save}
              disabled={busy !== null || !dirty}
            >
              {busy === "save" ? "Saving..." : "Save"}
            </button>
          </div>
          </>
          )}
        </div>
      </div>

      {/* ── Connection ── */}
      <div className="set-group">
        <div className="set-row set-row--stack">
          <div className="set-row-header">
            <div className="set-row-info">
              <span className="set-row-label">Connection</span>
              <span className="set-row-desc">
                What the sync engine sees right now. Refresh makes one request to the server.
              </span>
            </div>
            <button
              type="button"
              className="settings-action-btn"
              onClick={refreshStatus}
              disabled={statusBusy}
            >
              <IconRefresh size={14} />
              {statusBusy ? "Checking..." : "Refresh"}
            </button>
          </div>
          {statusError && <div className="dev-notice dev-notice--err">{statusError}</div>}
          {status && (
            <div className="dev-stats">
              <Stat label="Server" value={status.server_url} mono />
              <Stat
                label="Reachable"
                value={
                  status.probe.ok
                    ? `yes, ${status.probe.rtt_ms} ms`
                    : status.probe.error ?? "no"
                }
              />
              <Stat
                label="Server version"
                value={status.probe.service_version ?? "-"}
              />
              <Stat
                label="API version"
                value={
                  status.probe.api_version
                    ? status.probe.api_version === status.expected_api_version
                      ? `${status.probe.api_version} (expected)`
                      : `${status.probe.api_version}, app expects ${status.expected_api_version}`
                    : "-"
                }
              />
              <Stat
                label="Database / Redis"
                value={
                  status.probe.db == null
                    ? "-"
                    : `${status.probe.db ? "ok" : "down"} / ${status.probe.redis ? "ok" : "down"}`
                }
              />
              <Stat label="Certificate pin" value={status.pinned ? "set" : "none"} />
              <Stat
                label="Engine"
                value={
                  !status.engine_running
                    ? "not running"
                    : status.signed_in
                      ? "signed in"
                      : "running, signed out"
                }
              />
              <Stat
                label="WebSocket"
                value={
                  status.ws_connected
                    ? `connected ${ago(status.ws.connected_since)}`
                    : status.ws.last_disconnect
                      ? `down since ${formatTime(status.ws.last_disconnect)}`
                      : "not connected"
                }
              />
              <Stat
                label="Connections this run"
                value={
                  status.ws.connections === 0
                    ? "0"
                    : `${status.ws.connections} (${status.ws.connections - 1} reconnects)`
                }
              />
              <Stat label="Device id" value={status.device_id ?? "-"} mono />
              <Stat
                label="Sync cursor"
                value={status.cursor == null ? "-" : `${status.cursor} (${formatTime(status.cursor)})`}
                mono
              />
              <Stat label="Last synced" value={status.last_synced_at ? ago(status.last_synced_at) : "-"} />
              <Stat label="Pending queue" value={String(status.pending_count)} />
              <Stat label="Pushes in flight" value={String(status.in_flight)} />
              <Stat label="Transfers recorded" value={String(status.pending_work)} />
              {quota && (
                <>
                  <Stat
                    label="Storage"
                    value={`${formatBytes(quota.used_bytes)} of ${formatBytes(quota.quota_bytes)}`}
                  />
                  <Stat label="Entries" value={`${quota.entry_count} of ${quota.entry_limit}`} />
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Updates ── */}
      <div className="set-group">
        <div className="set-row set-row--stack">
          <div className="set-row-header">
            <div className="set-row-info">
              <span className="set-row-label">
                Update feed
                <ChangedMark show={config.update_feed_url !== ""} />
              </span>
              <span className="set-row-desc">
                Read updates from your own feed instead of the official stable and beta
                feeds. A fork signs its bundles with its own key; paste that key here. A
                plain mirror of the official feed can leave it empty.
              </span>
            </div>
          </div>
          <div className="dev-form">
            <Field
              label="Feed URL"
              value={feedUrl}
              onChange={(v) => {
                setFeedUrl(v);
                setFeedNotice(null);
              }}
              placeholder="https://example.com/latest.json (empty for official)"
              mono
            />
            <Field
              label="Minisign public key"
              value={pubkey}
              onChange={(v) => {
                setPubkey(v);
                setFeedNotice(null);
              }}
              placeholder="Empty keeps the built-in key"
              mono
            />
          </div>
          {feedNotice && <div className="dev-notice dev-notice--info">{feedNotice}</div>}
          <div className="dev-actions dev-actions--end">
            <button
              type="button"
              className="settings-action-btn dev-primary"
              onClick={saveFeed}
              disabled={feedBusy || !feedDirty}
            >
              {feedBusy ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
};

export default DeveloperSection;
