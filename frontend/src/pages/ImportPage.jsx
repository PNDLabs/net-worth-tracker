import { useState } from 'react';
import { api } from '../hooks/api';

const IMPORT_TYPES = [
  { value: 'accounts', label: 'Accounts (bank / investment)', icon: '🏦' },
  { value: 'assets', label: 'Assets (real estate, vehicles, etc.)', icon: '🏠' },
  { value: 'liabilities', label: 'Liabilities (loans, credit cards, etc.)', icon: '💳' },
];

const CSV_TEMPLATES = {
  accounts: `name,institution,type,currency,balance
Chase Checking,Chase Bank,checking,USD,5000
Savings Account,Bank of America,savings,USD,12000
401k,Fidelity,401k,USD,85000`,
  assets: `name,category,acquisition_date,acquisition_cost,current_value
Primary Home,real_estate,2020-06-15,350000,420000
Tesla Model 3,vehicle,2022-01-10,42000,32000
Bitcoin,crypto,,25000,30000`,
  liabilities: `name,lender,type,original_principal,current_balance,interest_rate,minimum_payment
Home Mortgage,Wells Fargo,mortgage,400000,375000,3.5,2100
Car Loan,Toyota Finance,auto,28000,19500,4.9,450
Credit Card,Chase,credit_card,,3200,19.99,96`,
};

// ─── PDF Preview Panel ────────────────────────────────────────────────────────
function PdfPreviewPanel({ preview, onConfirm, onCancel, loading }) {
  const [importType, setImportType] = useState(preview.import_type);

  if (!preview) return null;
  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <span style={{ fontSize: 20 }}>🔍</span>
        <strong style={{ fontSize: 16 }}>Preview — {preview.records.length} record(s) detected</strong>
        <span style={{
          marginLeft: 'auto', padding: '2px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700,
          background: preview.method === 'ai' ? '#e8f5e9' : '#fff3e0',
          color: preview.method === 'ai' ? '#2e7d32' : '#e65100',
        }}>
          {preview.method === 'ai' ? '🤖 AI-parsed' : '🔎 Pattern-parsed'}
        </span>
      </div>

      <div className="form-group mb-4" style={{ maxWidth: 320 }}>
        <label>Import As</label>
        <select value={importType} onChange={(e) => setImportType(e.target.value)}>
          {IMPORT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
      </div>

      <div className="table-container" style={{ marginBottom: 16, maxHeight: 300, overflowY: 'auto' }}>
        <table>
          <thead>
            <tr>
              {Object.keys(preview.records[0] || {}).map((k) => (
                <th key={k}>{k.replace(/_/g, ' ')}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.records.map((r, i) => (
              <tr key={i}>
                {Object.values(r).map((v, j) => (
                  <td key={j}>{v === null ? '—' : String(v)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {preview.raw_preview && (
        <details style={{ marginBottom: 16 }}>
          <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--color-text-muted)' }}>
            📄 Raw extracted text (first 2000 chars)
          </summary>
          <pre style={{ fontSize: 11, background: 'var(--color-surface-2)', padding: 10, borderRadius: 6, overflow: 'auto', maxHeight: 200, whiteSpace: 'pre-wrap', border: '1px solid var(--color-border)', marginTop: 8 }}>
            {preview.raw_preview}
          </pre>
        </details>
      )}

      <div style={{ display: 'flex', gap: 10 }}>
        <button className="btn-primary" onClick={() => onConfirm(importType)} disabled={loading}>
          {loading ? <><span className="spinner" style={{ width: 14, height: 14 }} /> Importing…</> : `✅ Confirm & Import ${preview.records.length} Record(s)`}
        </button>
        <button className="btn-ghost" onClick={onCancel} disabled={loading}>Cancel</button>
      </div>
    </div>
  );
}

// ─── Main ImportPage ──────────────────────────────────────────────────────────
export default function ImportPage({ onRefresh }) {
  const [importType, setImportType] = useState('accounts');
  const [csvFile, setCsvFile] = useState(null);
  const [jsonText, setJsonText] = useState('');
  const [pdfFile, setPdfFile] = useState(null);
  const [pdfPassword, setPdfPassword] = useState('');
  const [aiApiKey, setAiApiKey] = useState('');
  const [showAiKey, setShowAiKey] = useState(false);
  const [pdfPreview, setPdfPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState('pdf');

  async function importCsv() {
    if (!csvFile) return setError('Please select a CSV file.');
    try {
      setLoading(true); setError(''); setResult(null);
      const res = await api.importCsv(importType, csvFile);
      setResult(res);
      if (onRefresh) onRefresh();
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }

  async function importJson() {
    if (!jsonText.trim()) return setError('Please enter JSON data.');
    let records;
    try { records = JSON.parse(jsonText); }
    catch { return setError('Invalid JSON. Please check your input.'); }
    if (!Array.isArray(records)) return setError('JSON must be an array of records.');
    try {
      setLoading(true); setError(''); setResult(null);
      const res = await api.importJson(importType, records);
      setResult(res);
      if (onRefresh) onRefresh();
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }

  async function previewPdf() {
    if (!pdfFile) return setError('Please select a PDF file.');
    try {
      setLoading(true); setError(''); setResult(null); setPdfPreview(null);
      const preview = await api.previewPdf(pdfFile, pdfPassword, aiApiKey);
      if (!preview.records || preview.records.length === 0) {
        setError(
          'No financial records could be extracted from this PDF. ' +
          'Make sure the PDF contains selectable text (scanned/image-only PDFs are not supported). ' +
          'Adding an AI API key can significantly improve accuracy for complex statement layouts.'
        );
        return;
      }
      setPdfPreview(preview);
    } catch (e) {
      if (e.code === 'PASSWORD_REQUIRED') {
        setError('🔒 ' + e.message);
      } else {
        setError(e.message);
      }
    } finally { setLoading(false); }
  }

  async function confirmPdfImport(overrideType) {
    try {
      setLoading(true); setError('');
      const res = await api.importPdf(pdfFile, pdfPassword, aiApiKey, overrideType);
      setResult(res);
      setPdfPreview(null);
      setPdfFile(null);
      setPdfPassword('');
      if (onRefresh) onRefresh();
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }

  return (
    <div>
      <div className="page-header">
        <h2>Import Data</h2>
      </div>

      <div className="import-grid" style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 24 }}>
        {/* Left panel: type selector */}
        <div>
          <div className="card">
            <div className="section-title">What to Import</div>
            {IMPORT_TYPES.map((t) => (
              <button
                key={t.value}
                onClick={() => setImportType(t.value)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                  padding: '10px 12px', marginBottom: 4, textAlign: 'left',
                  borderRadius: 8, border: importType === t.value ? '2px solid var(--color-primary)' : '2px solid transparent',
                  background: importType === t.value ? '#e8f0fe' : 'transparent',
                  color: importType === t.value ? 'var(--color-primary)' : 'var(--color-text)',
                  fontWeight: 500,
                }}
              >
                <span style={{ fontSize: 18 }}>{t.icon}</span>
                <span style={{ fontSize: 13 }}>{t.label}</span>
              </button>
            ))}
          </div>

          {tab === 'csv' && (
            <div className="card mt-4">
              <div className="section-title">CSV Template</div>
              <p style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 8 }}>
                Copy the template below to create your CSV file.
              </p>
              <pre style={{ fontSize: 11, background: 'var(--color-surface-2)', padding: 10, borderRadius: 6, overflow: 'auto', whiteSpace: 'pre-wrap', border: '1px solid var(--color-border)' }}>
                {CSV_TEMPLATES[importType]}
              </pre>
            </div>
          )}

          {tab === 'pdf' && (
            <div className="card mt-4">
              <div className="section-title">PDF Tips</div>
              <ul style={{ fontSize: 12, color: 'var(--color-text-muted)', paddingLeft: 16, lineHeight: 2 }}>
                <li>Supports bank, investment, and loan statements</li>
                <li>Password-protected PDFs supported</li>
                <li>Add an AI key for higher accuracy</li>
                <li>Review the preview before importing</li>
                <li>Scanned / image-only PDFs are not supported</li>
              </ul>
            </div>
          )}
        </div>

        {/* Right panel: import form */}
        <div>
          <div className="card" style={{ marginBottom: pdfPreview ? 16 : 0 }}>
            <div className="flex-gap mb-4" style={{ gap: 0, borderBottom: '1px solid var(--color-border)', marginBottom: 20 }}>
              {['pdf', 'csv', 'json'].map((t) => (
                <button
                  key={t}
                  onClick={() => { setTab(t); setError(''); setResult(null); setPdfPreview(null); }}
                  style={{
                    borderRadius: 0, borderBottom: tab === t ? '2px solid var(--color-primary)' : '2px solid transparent',
                    background: 'none', padding: '8px 20px',
                    color: tab === t ? 'var(--color-primary)' : 'var(--color-text-muted)',
                    fontWeight: tab === t ? 700 : 400,
                  }}
                >
                  {t === 'pdf' ? '📄 PDF' : t.toUpperCase()}
                </button>
              ))}
            </div>

            {error && <div className="error-msg">{error}</div>}
            {result && (
              <div className={result.skipped === 0 ? 'success-msg' : 'error-msg'}>
                ✅ Imported <strong>{result.imported}</strong> records.
                {result.skipped > 0 && <> ⚠️ Skipped <strong>{result.skipped}</strong> rows with errors.</>}
                {result.errors?.length > 0 && (
                  <ul style={{ marginTop: 6, paddingLeft: 16 }}>
                    {result.errors.map((e, i) => <li key={i}>Row {e.row}: {e.message}</li>)}
                  </ul>
                )}
              </div>
            )}

            {tab === 'pdf' && (
              <>
                <div className="form-row">
                  <div className="form-group">
                    <label>Select PDF Statement</label>
                    <input
                      type="file"
                      accept=".pdf,application/pdf"
                      onChange={(e) => { setPdfFile(e.target.files[0]); setPdfPreview(null); setResult(null); setError(''); }}
                    />
                  </div>
                  <div className="form-group">
                    <label>🔒 PDF Password (if protected)</label>
                    <input
                      type="password"
                      value={pdfPassword}
                      onChange={(e) => setPdfPassword(e.target.value)}
                      placeholder="Leave blank if not password-protected"
                      autoComplete="off"
                    />
                  </div>
                </div>

                <div className="form-group mb-4">
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    🤖 AI API Key
                    <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--color-text-muted)' }}>(optional – for more accurate parsing)</span>
                    <button
                      className="btn-ghost btn-sm"
                      style={{ marginLeft: 'auto' }}
                      onClick={() => setShowAiKey((v) => !v)}
                      type="button"
                    >
                      {showAiKey ? 'Hide' : 'Show'}
                    </button>
                  </label>
                  <input
                    type={showAiKey ? 'text' : 'password'}
                    value={aiApiKey}
                    onChange={(e) => setAiApiKey(e.target.value)}
                    placeholder="sk-… (OpenAI or compatible API key)"
                    autoComplete="off"
                  />
                  <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                    Key is sent only to your local backend server. Set <code>AI_API_URL</code> in the backend <code>.env</code> file to use Ollama or other OpenAI-compatible providers instead of OpenAI.
                  </span>
                </div>

                <button className="btn-primary" onClick={previewPdf} disabled={loading || !pdfFile}>
                  {loading ? <><span className="spinner" style={{ width: 14, height: 14 }} /> Parsing PDF…</> : '🔍 Parse & Preview'}
                </button>
              </>
            )}

            {tab === 'csv' && (
              <>
                <div className="form-group mb-4">
                  <label>Select CSV File</label>
                  <input type="file" accept=".csv,text/csv" onChange={(e) => setCsvFile(e.target.files[0])} />
                </div>
                <button className="btn-primary" onClick={importCsv} disabled={loading}>
                  {loading ? <><span className="spinner" style={{ width: 14, height: 14 }} /> Importing…</> : '📥 Import CSV'}
                </button>
              </>
            )}

            {tab === 'json' && (
              <>
                <div className="form-group mb-4">
                  <label>JSON Array of Records</label>
                  <textarea
                    rows={14}
                    value={jsonText}
                    onChange={(e) => setJsonText(e.target.value)}
                    placeholder={`[\n  { "name": "Chase Checking", "type": "checking", "balance": 5000 }\n]`}
                    style={{ fontFamily: 'monospace', fontSize: 12 }}
                  />
                </div>
                <button className="btn-primary" onClick={importJson} disabled={loading}>
                  {loading ? <><span className="spinner" style={{ width: 14, height: 14 }} /> Importing…</> : '📥 Import JSON'}
                </button>
              </>
            )}
          </div>

          {/* PDF Preview */}
          {pdfPreview && (
            <PdfPreviewPanel
              preview={pdfPreview}
              loading={loading}
              onConfirm={confirmPdfImport}
              onCancel={() => setPdfPreview(null)}
            />
          )}
        </div>
      </div>
    </div>
  );
}
