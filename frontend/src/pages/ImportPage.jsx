import { useState, useEffect } from 'react';
import { api } from '../hooks/apiAdapter';

const IMPORT_TYPES = [
  { value: 'accounts', label: 'Accounts (bank / investment)', icon: '🏦' },
  { value: 'assets', label: 'Assets (real estate, vehicles, etc.)', icon: '🏠' },
  { value: 'liabilities', label: 'Liabilities (loans, credit cards, etc.)', icon: '💳' },
  { value: 'insurance', label: 'Insurance (policies, coverage)', icon: '🛡️' },
  { value: 'sip', label: 'SIP Installments (mutual funds)', icon: '💰' },
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
  insurance: `name,provider,type,policy_number,premium_amount,premium_frequency,coverage_amount,start_date,end_date,renewal_date,notes
Life Insurance,Prudential,life,POL-123456,200,monthly,500000,2020-01-01,,2025-01-01,
Health Plan,BlueCross,health,HC-789,350,monthly,1000000,2024-01-01,2024-12-31,2025-01-01,
Auto Insurance,State Farm,auto,AU-456,120,monthly,100000,2024-06-01,2025-06-01,,`,
  sip: `name,symbol,amount,units,nav,installment_date,notes
NIFTY 50 Index Fund SIP,NIFTYBEES,5000,26.286,190.25,2025-01-15,January SIP
Axis Bluechip Fund SIP,AXISBLUECHIP,5000,10.234,488.80,2025-01-15,
HDFC Mid-Cap Opportunities SIP,,5000,,,2025-01-15,`,
};

// ─── PDF Preview Panel ────────────────────────────────────────────────────────
function PdfPreviewPanel({ preview, onConfirm, onCancel, loading }) {
  const [importType, setImportType] = useState(preview.import_type);
  const validationNotes = preview.validation_notes || [];
  const [duplicateIndices, setDuplicateIndices] = useState(new Set());
  const [forceImportIndices, setForceImportIndices] = useState(new Set());
  const [checkingDuplicates, setCheckingDuplicates] = useState(false);
  // Cache check results per import type so switching back doesn't re-query the DB.
  const dupCacheRef = useState(() => ({}))[0];

  useEffect(() => {
    if (!preview.records || preview.records.length === 0) return;
    if (dupCacheRef[importType] !== undefined) {
      setDuplicateIndices(dupCacheRef[importType]);
      setForceImportIndices(new Set());
      return;
    }
    let cancelled = false;
    setCheckingDuplicates(true);
    setForceImportIndices(new Set());
    api.checkDuplicates(importType, preview.records)
      .then((res) => {
        const result = new Set(res.duplicates || []);
        dupCacheRef[importType] = result;
        if (!cancelled) setDuplicateIndices(result);
      })
      .catch(() => {
        dupCacheRef[importType] = new Set();
        if (!cancelled) setDuplicateIndices(new Set());
      })
      .finally(() => { if (!cancelled) setCheckingDuplicates(false); });
    return () => { cancelled = true; };
  }, [importType, preview]); // re-run when type changes or a fresh preview is loaded

  const toggleForce = (idx) => {
    setForceImportIndices((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      return next;
    });
  };

  const handleConfirm = () => {
    const finalRecords = preview.records.map((r, i) =>
      forceImportIndices.has(i) ? { ...r, _forceImport: true } : r
    );
    onConfirm(importType, finalRecords);
  };

  if (!preview) return null;
  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 20 }}>🔍</span>
        <strong style={{ fontSize: 16 }}>Preview — {preview.records.length} record(s) detected</strong>
        <span style={{
          marginLeft: 'auto', padding: '2px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700,
          background: preview.method === 'ai' ? '#e8f5e9' : '#fff3e0',
          color: preview.method === 'ai' ? '#2e7d32' : '#e65100',
        }}>
          {preview.method === 'ai' ? '🤖 AI-parsed' : '🔎 Pattern-parsed'}
        </span>
        {preview.method === 'ai' && validationNotes.length > 0 && (
          <span style={{
            padding: '2px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700,
            background: '#e3f2fd', color: '#1565c0',
          }}>
            ✏️ AI refined {validationNotes.length} {validationNotes.length !== 1 ? 'changes' : 'change'}
          </span>
        )}
      </div>

      <div className="form-group mb-4" style={{ maxWidth: 320 }}>
        <label>Import As</label>
        <select value={importType} onChange={(e) => setImportType(e.target.value)}>
          {IMPORT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
      </div>

      {checkingDuplicates && (
        <div style={{ padding: '8px 12px', borderRadius: 6, fontSize: 13, background: 'var(--color-surface-2)', color: 'var(--color-text-muted)', border: '1px solid var(--color-border)', marginBottom: 12 }}>
          🔍 Checking for existing records…
        </div>
      )}

      {!checkingDuplicates && duplicateIndices.size > 0 && (
        <div style={{ padding: '10px 14px', borderRadius: 6, fontSize: 13, background: '#fff3e0', color: '#e65100', border: '1px solid #ffcc80', marginBottom: 12 }}>
          ⚠️ <strong>{duplicateIndices.size}</strong> record(s) appear to already exist (matching name was found).
          Check <strong>"Import anyway"</strong> on each row you want to create as a new entry.
          Rows left unchecked will be skipped.
        </div>
      )}

      <div className="table-container" style={{ marginBottom: 16, maxHeight: 300, overflowY: 'auto' }}>
        <table>
          <thead>
            <tr>
              {duplicateIndices.size > 0 && <th style={{ whiteSpace: 'nowrap' }}>Status</th>}
              {Object.keys(preview.records[0] || {}).map((k) => (
                <th key={k}>{k.replace(/_/g, ' ')}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.records.map((r, i) => (
              <tr key={i} style={duplicateIndices.has(i) && !forceImportIndices.has(i) ? { background: '#fff8e1' } : {}}>
                {duplicateIndices.size > 0 && (
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {duplicateIndices.has(i) ? (
                      <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={forceImportIndices.has(i)}
                          onChange={() => toggleForce(i)}
                        />
                        <span style={{ fontSize: 11, fontWeight: 600, color: forceImportIndices.has(i) ? 'var(--color-success)' : '#e65100' }}>
                          {forceImportIndices.has(i) ? '✅ Import anyway' : '⚠️ Duplicate — skip'}
                        </span>
                      </label>
                    ) : (
                      <span style={{ fontSize: 11, color: 'var(--color-success)' }}>✅ New</span>
                    )}
                  </td>
                )}
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

      {validationNotes.length > 0 && (
        <details style={{ marginBottom: 16 }}>
          <summary style={{ cursor: 'pointer', fontSize: 12, color: '#1565c0' }}>
            ✏️ AI refinements ({validationNotes.length})
          </summary>
          <ul style={{ fontSize: 12, marginTop: 8, paddingLeft: 20, lineHeight: 1.8, color: 'var(--color-text-muted)' }}>
            {validationNotes.map((note, i) => <li key={i}>{note}</li>)}
          </ul>
        </details>
      )}

      <div style={{ display: 'flex', gap: 10 }}>
        <button className="btn-primary" onClick={handleConfirm} disabled={loading || checkingDuplicates}>
          {loading ? <><span className="spinner" style={{ width: 14, height: 14 }} /> Importing…</>
            : checkingDuplicates ? '🔍 Checking…'
            : `✅ Confirm & Import ${preview.records.length} Record(s)`}
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
  const [pasteText, setPasteText] = useState('');
  const [pdfFile, setPdfFile] = useState(null);
  const [pdfPassword, setPdfPassword] = useState('');
  const [serverAiEnabled, setServerAiEnabled] = useState(false);
  const [pdfPreview, setPdfPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState('pdf');

  useEffect(() => {
    api.getConfig().then((cfg) => setServerAiEnabled(!!cfg.aiEnabled)).catch(() => {});
  }, []);

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
      const preview = await api.previewPdf(pdfFile, pdfPassword);
      if (!preview.records || preview.records.length === 0) {
        setError(
          'No financial records could be extracted from this PDF. ' +
          'Make sure the PDF contains selectable text (scanned/image-only PDFs are not supported). ' +
          (serverAiEnabled ? '' : 'Enable AI parsing via AI_API_KEY in the server .env for better accuracy.')
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

  async function confirmPdfImport(overrideType, finalRecords) {
    try {
      setLoading(true); setError('');
      const records = finalRecords || pdfPreview?.records;
      let res;
      if (pdfPreview?.isText) {
        res = await api.importJson(overrideType, records);
      } else {
        res = await api.importPdf(pdfFile, pdfPassword, overrideType, records);
      }
      setResult(res);
      setPdfPreview(null);
      setPdfFile(null);
      setPdfPassword('');
      if (onRefresh) onRefresh();
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }

  async function importText() {
    if (!pasteText.trim()) return setError('Please paste some text to import.');
    try {
      setLoading(true); setError(''); setResult(null); setPdfPreview(null);
      const preview = await api.parseText(pasteText, importType);
      if (!preview.records || preview.records.length === 0) {
        setError('No financial records could be extracted from the text. Try adding more detail or use CSV/JSON import.');
        return;
      }
      setPdfPreview({ ...preview, isText: true });
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
                <li>Supports bank, investment, loan, insurance, and <strong>SIP / mutual fund</strong> statements</li>
                <li>SIP statements auto-detected from CAMS, KFintech, or similar AMC PDFs</li>
                <li>Password-protected PDFs supported</li>
                <li>Set <code>AI_API_KEY</code> in <code>.env</code> for best accuracy</li>
                <li>Review the preview before importing</li>
                <li>Scanned / image-only PDFs are not supported</li>
              </ul>
            </div>
          )}

          {tab === 'text' && (
            <div className="card mt-4">
              <div className="section-title">Text Import Tips</div>
              <ul style={{ fontSize: 12, color: 'var(--color-text-muted)', paddingLeft: 16, lineHeight: 2 }}>
                <li>Paste text from emails, statements, or any source</li>
                <li>Works best with AI enabled (<code>AI_API_KEY</code> in <code>.env</code>)</li>
                <li>Review the preview before confirming</li>
              </ul>
            </div>
          )}
        </div>

        {/* Right panel: import form */}
        <div>
          <div className="card" style={{ marginBottom: pdfPreview ? 16 : 0 }}>
            <div className="flex-gap mb-4" style={{ gap: 0, borderBottom: '1px solid var(--color-border)', marginBottom: 20 }}>
              {['pdf', 'text', 'csv', 'json'].map((t) => (
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
                  {t === 'pdf' ? '📄 PDF' : t === 'text' ? '📝 Text' : t.toUpperCase()}
                </button>
              ))}
            </div>

            {!serverAiEnabled && (tab === 'pdf' || tab === 'text') && (
              <div style={{ padding: '8px 12px', borderRadius: 6, fontSize: 12, background: '#fff3e0', color: '#e65100', border: '1px solid #ffcc80', marginBottom: 12 }}>
                💡 AI parsing is not configured. Set <code>AI_API_KEY</code> in the server <code>.env</code> file for smarter extraction.
              </div>
            )}
            {serverAiEnabled && (tab === 'pdf' || tab === 'text') && (
              <div style={{ padding: '8px 12px', borderRadius: 6, fontSize: 12, background: '#e8f5e9', color: '#2e7d32', border: '1px solid #a5d6a7', marginBottom: 12 }}>
                ✅ AI parsing enabled.
              </div>
            )}

            {error && <div className="error-msg">{error}</div>}
            {result && (
              <div className={(result.skipped - (result.duplicates || 0)) > 0 ? 'error-msg' : 'success-msg'}>
                ✅ Imported <strong>{result.imported}</strong> record(s).
                {result.duplicates > 0 && (
                  <> ⚠️ Skipped <strong>{result.duplicates}</strong> duplicate(s) (already exist).</>
                )}
                {(result.skipped - (result.duplicates || 0)) > 0 && (
                  <> ❌ <strong>{result.skipped - (result.duplicates || 0)}</strong> row(s) had errors.</>
                )}
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

                <button className="btn-primary" onClick={previewPdf} disabled={loading || !pdfFile}>
                  {loading ? <><span className="spinner" style={{ width: 14, height: 14 }} /> Parsing PDF…</> : '🔍 Parse & Preview'}
                </button>
              </>
            )}

            {tab === 'text' && (
              <>
                <div className="form-group mb-4">
                  <label>Paste financial document text</label>
                  <textarea
                    rows={12}
                    value={pasteText}
                    onChange={(e) => { setPasteText(e.target.value); setPdfPreview(null); setResult(null); setError(''); }}
                    placeholder="Paste text from a bank statement, insurance policy, investment report, or any financial document…"
                    style={{ fontFamily: 'monospace', fontSize: 12 }}
                  />
                </div>
                <button className="btn-primary" onClick={importText} disabled={loading || !pasteText.trim()}>
                  {loading ? <><span className="spinner" style={{ width: 14, height: 14 }} /> Parsing…</> : '🔍 Parse & Preview'}
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
