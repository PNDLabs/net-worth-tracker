/**
 * SettingsPage.jsx
 *
 * Allows the user to configure AI API credentials that are used by the
 * Android app's local statement parser when no backend server is available.
 *
 * On web (Docker), this page shows read-only information about the server-side
 * AI configuration obtained from GET /api/config.
 *
 * On Android (native), the user can enter and save their AI API key, URL,
 * and model.  These are stored securely via @capacitor/preferences.
 */

import { useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { api } from '../hooks/apiAdapter';
import { APP_VERSION } from '../version';

const isNative = typeof Capacitor !== 'undefined' && Capacitor.isNativePlatform();

const DEFAULT_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';

export default function SettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  // Native Android state
  const [form, setForm] = useState({ apiKey: '', apiUrl: DEFAULT_URL, model: DEFAULT_MODEL });
  const [showKey, setShowKey] = useState(false);

  // Web state
  const [webConfig, setWebConfig] = useState(null);

  // Export / import state
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importStats, setImportStats] = useState(null);
  const importFileRef = useRef(null);

  useEffect(() => {
    if (isNative) {
      api.getAiSettings()
        .then((s) => setForm({ apiKey: s.apiKey || '', apiUrl: s.apiUrl || DEFAULT_URL, model: s.model || DEFAULT_MODEL }))
        .catch((e) => setError(e.message))
        .finally(() => setLoading(false));
    } else {
      api.getConfig()
        .then((cfg) => setWebConfig(cfg))
        .catch((e) => setError(e.message))
        .finally(() => setLoading(false));
    }
  }, []);

  async function save() {
    try {
      setSaving(true);
      setError('');
      await api.saveAiSettings(form);
      setMsg('Settings saved successfully.');
      setTimeout(() => setMsg(''), 3000);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function clearKey() {
    if (!confirm('Clear the stored AI API key?')) return;
    try {
      await api.saveAiSettings({ apiKey: '', apiUrl: DEFAULT_URL, model: DEFAULT_MODEL });
      setForm({ apiKey: '', apiUrl: DEFAULT_URL, model: DEFAULT_MODEL });
      setMsg('AI settings cleared.');
      setTimeout(() => setMsg(''), 3000);
    } catch (e) {
      setError(e.message);
    }
  }

  async function handleExport() {
    try {
      setExporting(true);
      setError('');
      const payload = await api.exportData();
      const json = JSON.stringify(payload, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      const date = new Date().toISOString().slice(0, 10);
      a.href     = url;
      a.download = `networth-export-${date}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setMsg('Data exported successfully.');
      setTimeout(() => setMsg(''), 4000);
    } catch (e) {
      setError(e.message);
    } finally {
      setExporting(false);
    }
  }

  async function handleImportFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    // Reset file input so the same file can be re-selected
    e.target.value = '';

    try {
      setImporting(true);
      setError('');
      setImportStats(null);

      const text    = await file.text();
      const payload = JSON.parse(text);
      const result  = await api.importFullData(payload);
      setImportStats(result.stats ?? result);
      setMsg('Data imported successfully.');
      setTimeout(() => setMsg(''), 5000);
    } catch (e) {
      setError(e.message);
    } finally {
      setImporting(false);
    }
  }

  if (loading) return <div className="loading-center"><div className="spinner" /></div>;

  return (
    <div>
      <div className="page-header">
        <h2>⚙️ Settings</h2>
      </div>

      {error && <div className="error-msg">{error}</div>}
      {msg && <div className="success-msg">{msg}</div>}

      {/* ── Android: AI API Key configuration ── */}
      {isNative && (
        <div className="card" style={{ maxWidth: 540 }}>
          <div className="section-title">🤖 AI API Configuration</div>
          <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 16 }}>
            Enter your OpenAI-compatible API key to enable AI-powered PDF statement parsing.
            The key is stored securely on your device and never sent to any server other than the
            AI API endpoint you configure.
          </p>

          <div className="form-group">
            <label>API Key</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type={showKey ? 'text' : 'password'}
                value={form.apiKey}
                onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                placeholder="sk-..."
                style={{ flex: 1, fontFamily: 'monospace' }}
              />
              <button className="btn-ghost btn-sm" onClick={() => setShowKey((v) => !v)}>
                {showKey ? '🙈 Hide' : '👁 Show'}
              </button>
            </div>
          </div>

          <div className="form-group">
            <label>API URL</label>
            <input
              value={form.apiUrl}
              onChange={(e) => setForm({ ...form, apiUrl: e.target.value })}
              placeholder={DEFAULT_URL}
            />
            <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 4 }}>
              Use the default for OpenAI. Change for OpenRouter, local LLM, or other compatible endpoints.
            </div>
          </div>

          <div className="form-group mb-4">
            <label>Model</label>
            <input
              value={form.model}
              onChange={(e) => setForm({ ...form, model: e.target.value })}
              placeholder={DEFAULT_MODEL}
            />
            <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 4 }}>
              e.g. gpt-4o-mini, gpt-4o, claude-3-haiku-20240307
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn-primary" onClick={save} disabled={saving}>
              {saving ? <><span className="spinner" style={{ width: 14, height: 14 }} /> Saving…</> : '💾 Save Settings'}
            </button>
            {form.apiKey && (
              <button className="btn-danger" onClick={clearKey}>🗑 Clear Key</button>
            )}
          </div>

          {form.apiKey && (
            <div style={{ marginTop: 12, padding: '8px 12px', background: 'var(--color-success-bg, #e6ffed)', borderRadius: 6, fontSize: 13, color: 'var(--color-success)' }}>
              ✅ AI key is configured — PDF import will use AI-powered parsing.
            </div>
          )}
          {!form.apiKey && (
            <div style={{ marginTop: 12, padding: '8px 12px', background: 'var(--color-surface-2)', borderRadius: 6, fontSize: 13, color: 'var(--color-text-muted)' }}>
              ℹ️ No AI key configured — PDF import will use pattern-based parsing only.
            </div>
          )}
        </div>
      )}

      {/* ── Web: read-only AI status ── */}
      {!isNative && (
        <div className="card" style={{ maxWidth: 540 }}>
          <div className="section-title">🤖 AI Configuration (Server)</div>
          <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 12 }}>
            On the web deployment, AI settings are configured via environment variables on the server
            (<code>AI_API_KEY</code>, <code>AI_API_URL</code>, <code>AI_MODEL</code>).
          </p>
          <div style={{ padding: '8px 12px', background: 'var(--color-surface-2)', borderRadius: 6, fontSize: 13 }}>
            {webConfig?.aiEnabled
              ? <span style={{ color: 'var(--color-success)' }}>✅ AI is enabled on the server.</span>
              : <span style={{ color: 'var(--color-text-muted)' }}>⚠️ AI is not configured on the server. Set <code>AI_API_KEY</code> in your environment to enable it.</span>
            }
          </div>
        </div>
      )}

      {/* ── Export / Import ── */}
      <div className="card" style={{ maxWidth: 540 }}>
        <div className="section-title">📦 Data Export &amp; Import</div>
        <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 16 }}>
          Export all your data to a JSON file to back it up or transfer it to another device.
          Import a previously exported file to restore or merge data.
        </p>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
          <button className="btn-primary" onClick={handleExport} disabled={exporting}>
            {exporting
              ? <><span className="spinner" style={{ width: 14, height: 14 }} /> Exporting…</>
              : '📤 Export Data'}
          </button>

          <button
            className="btn-ghost"
            onClick={() => importFileRef.current?.click()}
            disabled={importing}
          >
            {importing
              ? <><span className="spinner" style={{ width: 14, height: 14 }} /> Importing…</>
              : '📥 Import Data'}
          </button>
          <input
            ref={importFileRef}
            type="file"
            accept=".json,application/json"
            style={{ display: 'none' }}
            onChange={handleImportFile}
          />
        </div>

        {importStats && (
          <div style={{ background: 'var(--color-surface-2)', borderRadius: 6, padding: '10px 14px', fontSize: 13 }}>
            <strong>Import results:</strong>
            <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', paddingBottom: 4, color: 'var(--color-text-muted)', fontWeight: 500 }}>Table</th>
                  <th style={{ textAlign: 'right', paddingBottom: 4, color: 'var(--color-text-muted)', fontWeight: 500 }}>Imported</th>
                  <th style={{ textAlign: 'right', paddingBottom: 4, color: 'var(--color-text-muted)', fontWeight: 500 }}>Skipped</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(importStats).map(([table, s]) => (
                  <tr key={table}>
                    <td style={{ paddingTop: 2 }}>{table}</td>
                    <td style={{ textAlign: 'right', color: 'var(--color-success)' }}>{s.imported ?? '—'}</td>
                    <td style={{ textAlign: 'right', color: 'var(--color-text-muted)' }}>{s.skipped ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── About / Version ── */}
      <div className="card" style={{ maxWidth: 540 }}>
        <div className="section-title">ℹ️ About</div>
        <div style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
          <p style={{ margin: '0 0 4px' }}>Net Worth Tracker</p>
          <p style={{ margin: 0 }}>Version <strong>{APP_VERSION}</strong></p>
        </div>
      </div>
    </div>
  );
}
