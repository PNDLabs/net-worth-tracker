import { useState, useEffect } from 'react';
import { api } from '../hooks/apiAdapter';
import { useCurrency } from '../hooks/CurrencyContext';

const IMPORT_TYPES = [
  { value: 'accounts', label: 'Accounts (bank / investment)', icon: '🏦' },
  { value: 'assets', label: 'Assets (real estate, vehicles, etc.)', icon: '🏠' },
  { value: 'liabilities', label: 'Liabilities (loans, credit cards, etc.)', icon: '💳' },
  { value: 'insurance', label: 'Insurance (policies, coverage)', icon: '🛡️' },
];

function getCsvTemplates(currency) {
  const cur = currency || 'CURRENCY_CODE';
  return {
    accounts: `name,institution,type,currency,balance\nMy Checking,My Bank,checking,${cur},5000\nMy Savings,My Bank,savings,${cur},12000\nRetirement,My Broker,401k,${cur},85000`,
    assets: `name,category,acquisition_date,acquisition_cost,current_value\nPrimary Home,real_estate,2020-06-15,350000,420000\nCar,vehicle,2022-01-10,42000,32000\nBitcoin,crypto,,25000,30000`,
    liabilities: `name,lender,type,original_principal,current_balance,interest_rate,minimum_payment\nHome Mortgage,My Bank,mortgage,400000,375000,3.5,2100\nCar Loan,Auto Finance,auto,28000,19500,4.9,450\nCredit Card,My Bank,credit_card,,3200,19.99,96`,
    insurance: `name,provider,type,policy_number,premium_amount,premium_frequency,coverage_amount,start_date,end_date,renewal_date,notes\nLife Insurance,My Insurer,life,POL-123456,200,monthly,500000,2020-01-01,,2025-01-01,\nHealth Plan,My Insurer,health,HC-789,350,monthly,1000000,2024-01-01,2024-12-31,2025-01-01,`,
  };
}

// ─── PDF Preview Panel ────────────────────────────────────────────────────────
function PdfPreviewPanel({ preview, onConfirm, onCancel, loading }) {
  const [importType, setImportType] = useState(preview.import_type);
  const validationNotes = preview.validation_notes || [];
  const [duplicateIndices, setDuplicateIndices] = useState(new Set());
  // Indices of rows that are duplicates of an earlier row within the same imported file.
  const [withinBatchIndices, setWithinBatchIndices] = useState(new Set());
  // Map of index → 'skip' | 'create' | 'update'
  const [duplicateActions, setDuplicateActions] = useState(new Map());
  // Map of index → 'import' | 'skip' for genuinely new records
  const [newActions, setNewActions] = useState(new Map());
  const [checkingDuplicates, setCheckingDuplicates] = useState(false);
  // Cache check results per import type so switching back doesn't re-query the DB.
  const dupCacheRef = useState(() => ({}))[0];

  useEffect(() => {
    if (!preview.records || preview.records.length === 0) return;
    const cached = dupCacheRef[importType];
    // Guard: only use the cache if it has the expected shape (dbDups + batchDups Sets).
    if (cached && cached.dbDups instanceof Set && cached.batchDups instanceof Set) {
      setDuplicateIndices(cached.dbDups);
      setWithinBatchIndices(cached.batchDups);
      setDuplicateActions(new Map());
      return;
    }
    let cancelled = false;
    setCheckingDuplicates(true);
    setDuplicateActions(new Map());
    api.checkDuplicates(importType, preview.records)
      .then((res) => {
        const dbDups = new Set(res.duplicates || []);
        const batchDups = new Set(res.withinBatch || []);
        dupCacheRef[importType] = { dbDups, batchDups };
        if (!cancelled) {
          setDuplicateIndices(dbDups);
          setWithinBatchIndices(batchDups);
          setNewActions(new Map());
        }
      })
      .catch(() => {
        dupCacheRef[importType] = { dbDups: new Set(), batchDups: new Set() };
        if (!cancelled) {
          setDuplicateIndices(new Set());
          setWithinBatchIndices(new Set());
          setNewActions(new Map());
        }
      })
      .finally(() => { if (!cancelled) setCheckingDuplicates(false); });
    return () => { cancelled = true; };
  }, [importType, preview]); // re-run when type changes or a fresh preview is loaded

  const setAction = (idx, action) => {
    setDuplicateActions((prev) => {
      const next = new Map(prev);
      next.set(idx, action);
      return next;
    });
  };

  const setNewAction = (idx, action) => {
    setNewActions((prev) => {
      const next = new Map(prev);
      next.set(idx, action);
      return next;
    });
  };

  const shouldImportRecord = (i) => {
    const action = duplicateActions.get(i);
    const isBatchDup = withinBatchIndices.has(i);
    const isDup = duplicateIndices.has(i);
    const newAction = newActions.get(i) || 'import';
    if (isBatchDup && (!action || action === 'skip')) return false;
    if (!isDup && !isBatchDup && newAction === 'skip') return false;
    return true;
  };

  const handleConfirm = () => {
    const finalRecords = [];
    for (let i = 0; i < preview.records.length; i++) {
      if (!shouldImportRecord(i)) continue;
      const r = preview.records[i];
      const action = duplicateActions.get(i);
      if (action === 'create') {
        finalRecords.push({ ...r, _forceImport: true });
      } else if (action === 'update') {
        finalRecords.push({ ...r, _updateExisting: true });
      } else {
        finalRecords.push(r);
      }
    }
    onConfirm(importType, finalRecords);
  };

  // Count of records that will actually be imported with current selections.
  const netImportCount = preview.records.reduce((count, _r, i) => (
    shouldImportRecord(i) ? count + 1 : count
  ), 0);

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

      {(() => {
        const bannerBase = { padding: '10px 14px', borderRadius: 6, fontSize: 13 };
        return (
          <>
            {!checkingDuplicates && duplicateIndices.size > 0 && (
              <div style={{ ...bannerBase, background: '#fff3e0', color: '#e65100', border: '1px solid #ffcc80', marginBottom: 8 }}>
                ⚠️ <strong>{duplicateIndices.size}</strong> record(s) already exist in the database.
                For each, choose: <strong>Skip</strong> (default), <strong>Update existing</strong> (saves old value to history), or <strong>Create new</strong>.
              </div>
            )}
            {!checkingDuplicates && withinBatchIndices.size > 0 && (
              <div style={{ ...bannerBase, background: '#f3e5f5', color: '#6a1b9a', border: '1px solid #ce93d8', marginBottom: 12 }}>
                📋 <strong>{withinBatchIndices.size}</strong> record(s) appear more than once in this file (in-file duplicates — e.g. a summary and a detail row for the same account).
                The later occurrence(s) default to <strong>Skip</strong>. Choose <strong>Keep this one</strong> to import anyway.
              </div>
            )}
          </>
        );
      })()}

      <div className="table-container" style={{ marginBottom: 16, maxHeight: 300, overflowY: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th style={{ whiteSpace: 'nowrap' }}>Status</th>
              {Object.keys(preview.records[0] || {}).map((k) => (
                <th key={k}>{k.replace(/_/g, ' ')}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.records.map((r, i) => {
              const isDup = duplicateIndices.has(i);
              const isBatchDup = withinBatchIndices.has(i);
              const action = duplicateActions.get(i) || 'skip';
              const newAction = newActions.get(i) || 'import';
              const rowStyle = isDup
                ? { background: action === 'update' ? '#e8f5e9' : '#fff8e1' }
                : isBatchDup
                ? { background: action === 'create' ? '#e3f2fd' : '#f3e5f5' }
                : { background: newAction === 'skip' ? 'var(--color-surface-2)' : undefined };
              return (
                <tr key={i} style={rowStyle}>
                  <td style={{ whiteSpace: 'nowrap', minWidth: 160 }}>
                    {isDup ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                        {isBatchDup && (
                          <span style={{ fontSize: 10, fontWeight: 700, color: '#6a1b9a', marginBottom: 2 }}>📋 also in-file dup</span>
                        )}
                        {[
                          { value: 'skip', label: '⏭ Skip', color: '#e65100' },
                          { value: 'update', label: '🔄 Update existing', color: '#2e7d32' },
                          { value: 'create', label: '➕ Create new', color: '#1565c0' },
                        ].map((opt) => (
                          <label key={opt.value} style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
                            <input
                              type="radio"
                              name={`dup-action-${i}`}
                              value={opt.value}
                              checked={action === opt.value}
                              onChange={() => setAction(i, opt.value)}
                            />
                            <span style={{ fontSize: 11, fontWeight: 600, color: action === opt.value ? opt.color : 'var(--color-text-muted)' }}>
                              {opt.label}
                            </span>
                          </label>
                        ))}
                      </div>
                    ) : isBatchDup ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                        <span style={{ fontSize: 10, fontWeight: 700, color: '#6a1b9a', marginBottom: 2 }}>📋 In-file duplicate</span>
                        {[
                          { value: 'skip', label: '⏭ Skip (keep first)', color: '#e65100' },
                          { value: 'create', label: '➕ Keep this one', color: '#1565c0' },
                        ].map((opt) => (
                          <label key={opt.value} style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
                            <input
                              type="radio"
                              name={`dup-action-${i}`}
                              value={opt.value}
                              checked={action === opt.value}
                              onChange={() => setAction(i, opt.value)}
                            />
                            <span style={{ fontSize: 11, fontWeight: 600, color: action === opt.value ? opt.color : 'var(--color-text-muted)' }}>
                              {opt.label}
                            </span>
                          </label>
                        ))}
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                        {[
                          { value: 'import', label: '✅ Import', color: 'var(--color-success)' },
                          { value: 'skip', label: '⏭ Skip', color: '#e65100' },
                        ].map((opt) => (
                          <label key={opt.value} style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
                            <input
                              type="radio"
                              name={`new-action-${i}`}
                              value={opt.value}
                              checked={newAction === opt.value}
                              onChange={() => setNewAction(i, opt.value)}
                            />
                            <span style={{ fontSize: 11, fontWeight: 600, color: newAction === opt.value ? opt.color : 'var(--color-text-muted)' }}>
                              {opt.label}
                            </span>
                          </label>
                        ))}
                      </div>
                    )}
                  </td>
                  {Object.values(r).map((v, j) => (
                    <td key={j}>{v === null ? '—' : String(v)}</td>
                  ))}
                </tr>
              );
            })}
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
            : `✅ Confirm & Import ${netImportCount} of ${preview.records.length} Record(s)`}
        </button>
        <button className="btn-ghost" onClick={onCancel} disabled={loading}>Cancel</button>
      </div>
    </div>
  );
}

// ─── Main ImportPage ──────────────────────────────────────────────────────────
export default function ImportPage() {
  const [importType, setImportType] = useState('accounts');
  const [csvFile, setCsvFile] = useState(null);
  const [jsonText, setJsonText] = useState('');
  const [pasteText, setPasteText] = useState('');
  const [pdfFile, setPdfFile] = useState(null);
  const [pdfPassword, setPdfPassword] = useState('');
  const [serverAiEnabled, setServerAiEnabled] = useState(false);
  const [pdfPreview, setPdfPreview] = useState(null);
  const [csvPreview, setCsvPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState('pdf');
  const { currency } = useCurrency();
  const csvTemplates = getCsvTemplates(currency);

  useEffect(() => {
    api.getConfig().then((cfg) => setServerAiEnabled(!!cfg.aiEnabled)).catch(() => {});
  }, []);

  async function importCsv() {
    if (!csvFile) return setError('Please select a CSV file.');
    try {
      setLoading(true); setError(''); setResult(null); setCsvPreview(null);
      const preview = await api.previewCsv(importType, csvFile);
      if (!preview.records || preview.records.length === 0) {
        setError(
          preview.method === 'pattern'
            ? 'No records could be extracted. Column names did not match the expected format and AI mapping is not enabled. ' +
              'Enable AI by setting AI_API_KEY in the server .env, or use the CSV template for standard column names.'
            : 'No records could be extracted from the CSV file.'
        );
        return;
      }
      setCsvPreview(preview);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }

  async function confirmCsvImport(overrideType, finalRecords) {
    try {
      setLoading(true); setError('');
      const res = await api.importJson(overrideType, finalRecords);
      setResult(res);
      setCsvPreview(null);
      setCsvFile(null);
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
              <div className="section-title">CSV Tips</div>
              <p style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 8 }}>
                With AI enabled, <strong>any column names are accepted</strong> — the AI maps them automatically.<br />
                Without AI, column names must match the template exactly.
              </p>
              <div className="section-title" style={{ marginTop: 8 }}>Template</div>
              <pre style={{ fontSize: 11, background: 'var(--color-surface-2)', padding: 10, borderRadius: 6, overflow: 'auto', whiteSpace: 'pre-wrap', border: '1px solid var(--color-border)' }}>
                {csvTemplates[importType]}
              </pre>
            </div>
          )}

          {tab === 'pdf' && (
            <div className="card mt-4">
              <div className="section-title">PDF Tips</div>
              <ul style={{ fontSize: 12, color: 'var(--color-text-muted)', paddingLeft: 16, lineHeight: 2 }}>
                <li>Supports bank, investment, loan, insurance, and <strong>mutual fund / CAS</strong> statements</li>
                <li>Mutual fund / CAS statements auto-detected from CAMS, KFintech, or similar AMC PDFs and imported as brokerage accounts</li>
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
                  onClick={() => { setTab(t); setError(''); setResult(null); setPdfPreview(null); setCsvPreview(null); }}
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
                {result.updated > 0 && (
                  <> 🔄 Updated <strong>{result.updated}</strong> existing record(s).</>
                )}
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
                <div style={{ padding: '8px 12px', borderRadius: 6, fontSize: 12, background: serverAiEnabled ? '#e8f5e9' : '#fff3e0', color: serverAiEnabled ? '#2e7d32' : '#e65100', border: `1px solid ${serverAiEnabled ? '#a5d6a7' : '#ffcc80'}`, marginBottom: 12 }}>
                  {serverAiEnabled
                    ? '✅ AI column mapping enabled — any column names will be automatically understood.'
                    : '💡 Set AI_API_KEY in .env to enable smart column mapping for non-standard CSV formats.'}
                </div>
                <div className="form-group mb-4">
                  <label>Select CSV File</label>
                  <input type="file" accept=".csv,text/csv" onChange={(e) => { setCsvFile(e.target.files[0]); setCsvPreview(null); setResult(null); setError(''); }} />
                </div>
                <button className="btn-primary" onClick={importCsv} disabled={loading || !csvFile}>
                  {loading ? <><span className="spinner" style={{ width: 14, height: 14 }} /> Parsing…</> : '🔍 Parse & Preview'}
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

          {/* CSV Preview */}
          {csvPreview && (
            <PdfPreviewPanel
              preview={csvPreview}
              loading={loading}
              onConfirm={confirmCsvImport}
              onCancel={() => setCsvPreview(null)}
            />
          )}
        </div>
      </div>
    </div>
  );
}
