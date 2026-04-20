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

export default function ImportPage({ onRefresh }) {
  const [importType, setImportType] = useState('accounts');
  const [csvFile, setCsvFile] = useState(null);
  const [jsonText, setJsonText] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState('csv');

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

  return (
    <div>
      <div className="page-header">
        <h2>Import Data</h2>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 24 }}>
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

          <div className="card mt-4">
            <div className="section-title">CSV Template</div>
            <p style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 8 }}>
              Copy the template below to create your CSV file.
            </p>
            <pre style={{ fontSize: 11, background: 'var(--color-surface-2)', padding: 10, borderRadius: 6, overflow: 'auto', whiteSpace: 'pre-wrap', border: '1px solid var(--color-border)' }}>
              {CSV_TEMPLATES[importType]}
            </pre>
          </div>
        </div>

        {/* Right panel: import form */}
        <div className="card">
          <div className="flex-gap mb-4" style={{ gap: 0, borderBottom: '1px solid var(--color-border)', marginBottom: 20 }}>
            {['csv', 'json'].map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                style={{
                  borderRadius: 0, borderBottom: tab === t ? '2px solid var(--color-primary)' : '2px solid transparent',
                  background: 'none', padding: '8px 20px',
                  color: tab === t ? 'var(--color-primary)' : 'var(--color-text-muted)',
                  fontWeight: tab === t ? 700 : 400,
                }}
              >
                {t.toUpperCase()}
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

          {tab === 'csv' ? (
            <>
              <div className="form-group mb-4">
                <label>Select CSV File</label>
                <input type="file" accept=".csv,text/csv" onChange={(e) => setCsvFile(e.target.files[0])} />
              </div>
              <button className="btn-primary" onClick={importCsv} disabled={loading}>
                {loading ? <><span className="spinner" style={{ width: 14, height: 14 }} /> Importing…</> : '📥 Import CSV'}
              </button>
            </>
          ) : (
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
      </div>
    </div>
  );
}
