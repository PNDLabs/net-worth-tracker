import { useEffect, useState } from 'react';
import { api } from '../hooks/apiAdapter';
import { formatCurrency, formatDate, typeLabel } from '../hooks/format';
import { useCurrency } from '../hooks/CurrencyContext';

const INSURANCE_TYPES = [
  'life', 'term_life', 'health', 'dental', 'vision', 'auto', 'home',
  'renters', 'disability', 'umbrella', 'travel', 'pet', 'business', 'other',
];
const FREQUENCIES = ['monthly', 'quarterly', 'semi_annual', 'annual', 'one_time'];

const EMPTY = {
  name: '', provider: '', type: 'other', policy_number: '',
  premium_amount: '', premium_frequency: 'monthly', coverage_amount: '',
  fund_value: '',
  start_date: '', end_date: '', renewal_date: '', notes: '',
  terms: '', covered_conditions: [], insured_name: '',
};

function statusBadge(plan) {
  if (!plan.end_date) return null;
  const now = new Date();
  const end = new Date(plan.end_date);
  const daysLeft = Math.ceil((end - now) / (1000 * 60 * 60 * 24));
  if (daysLeft < 0) return { label: 'Expired', color: '#b71c1c', bg: '#ffebee' };
  if (daysLeft <= 30) return { label: `Expires in ${daysLeft}d`, color: '#e65100', bg: '#fff3e0' };
  if (daysLeft <= 90) return { label: `Expires in ${daysLeft}d`, color: '#f57f17', bg: '#fffde7' };
  return null;
}

function annualPremium(plan) {
  if (plan.premium_amount == null) return null;
  const multipliers = { monthly: 12, quarterly: 4, semi_annual: 2, annual: 1, one_time: 0 };
  return plan.premium_amount * (multipliers[plan.premium_frequency] ?? 12);
}

export default function InsurancePage() {
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [showCoverageDetails, setShowCoverageDetails] = useState(false);
  const [conditionInput, setConditionInput] = useState('');

  const [showAiModal, setShowAiModal] = useState(false);
  const [aiText, setAiText] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState('');

  const [showQueryModal, setShowQueryModal] = useState(false);
  const [queryText, setQueryText] = useState('');
  const [queryLoading, setQueryLoading] = useState(false);
  const [queryError, setQueryError] = useState('');
  const [queryResult, setQueryResult] = useState(null);

  const [showAnalyzeModal, setShowAnalyzeModal] = useState(false);
  const [analyzeLoading, setAnalyzeLoading] = useState(false);
  const [analyzeError, setAnalyzeError] = useState('');
  const [analyzeResult, setAnalyzeResult] = useState(null);

  const { currency } = useCurrency();
  const fmt = (v) => formatCurrency(v, currency);

  const load = () =>
    api.getInsurance().then(setPlans).catch(e => setError(e.message)).finally(() => setLoading(false));
  useEffect(() => { load(); }, []);

  async function parseFromText() {
    if (!aiText.trim()) return setAiError('Please paste some text to parse.');
    try {
      setAiLoading(true); setAiError('');
      const result = await api.parseText(aiText, 'insurance');
      const records = result.records || [];
      if (records.length === 0) {
        setAiError('No insurance records could be extracted. Try adding more detail or use the manual form.');
        return;
      }
      const r = records[0];
      setForm({
        name: r.name || '',
        provider: r.provider || '',
        type: r.type || 'other',
        policy_number: r.policy_number || '',
        premium_amount: r.premium_amount ?? '',
        premium_frequency: r.premium_frequency || 'monthly',
        coverage_amount: r.coverage_amount ?? '',
        fund_value: r.fund_value ?? '',
        start_date: r.start_date || '',
        end_date: r.end_date || '',
        renewal_date: r.renewal_date || '',
        notes: r.notes || '',
        // Pre-fill terms with the source text so the user doesn't have to paste again
        terms: aiText,
        covered_conditions: Array.isArray(r.covered_conditions) ? r.covered_conditions : [],
        insured_name: r.insured_name || '',
      });
      setEditing(null);
      setShowAiModal(false);
      setAiText('');
      setShowModal(true);
      setShowCoverageDetails(true);
      setError('');
    } catch (e) {
      setAiError(e.message);
    } finally {
      setAiLoading(false);
    }
  }

  function openCreate() {
    setEditing(null);
    setForm(EMPTY);
    setShowCoverageDetails(false);
    setConditionInput('');
    setShowModal(true);
    setError('');
  }

  function openEdit(p) {
    setEditing(p);
    setForm({
      ...p,
      premium_amount: p.premium_amount ?? '',
      coverage_amount: p.coverage_amount ?? '',
      fund_value: p.fund_value ?? '',
      start_date: p.start_date || '',
      end_date: p.end_date || '',
      renewal_date: p.renewal_date || '',
      policy_number: p.policy_number || '',
      provider: p.provider || '',
      notes: p.notes || '',
      terms: p.terms || '',
      covered_conditions: Array.isArray(p.covered_conditions) ? p.covered_conditions : [],
      insured_name: p.insured_name || '',
    });
    setShowCoverageDetails(!!(p.terms || (Array.isArray(p.covered_conditions) && p.covered_conditions.length > 0)));
    setConditionInput('');
    setShowModal(true);
    setError('');
  }

  function addConditionTag() {
    const tag = conditionInput.trim();
    if (!tag) return;
    if (!form.covered_conditions.includes(tag)) {
      setForm({ ...form, covered_conditions: [...form.covered_conditions, tag] });
    }
    setConditionInput('');
  }

  function removeConditionTag(tag) {
    setForm({ ...form, covered_conditions: form.covered_conditions.filter(t => t !== tag) });
  }

  async function save() {
    try {
      setError('');
      const payload = {
        ...form,
        premium_amount: form.premium_amount !== '' ? Number(form.premium_amount) : null,
        coverage_amount: form.coverage_amount !== '' ? Number(form.coverage_amount) : null,
        fund_value: form.fund_value !== '' ? Number(form.fund_value) : null,
        start_date: form.start_date || null,
        end_date: form.end_date || null,
        renewal_date: form.renewal_date || null,
        policy_number: form.policy_number || null,
        provider: form.provider || null,
        notes: form.notes || null,
        terms: form.terms || null,
        covered_conditions: form.covered_conditions,
      };
      if (editing) await api.updateInsurance(editing.id, payload);
      else await api.createInsurance(payload);
      setShowModal(false);
      load();
    } catch (e) { setError(e.message); }
  }

  async function remove(id) {
    if (!confirm('Delete this insurance plan?')) return;
    try { await api.deleteInsurance(id); load(); }
    catch (e) { setError(e.message); }
  }

  async function createVehicleAsset(plan) {
    const assetName = plan.insured_name || plan.name;
    if (!confirm(`Create a vehicle asset "${assetName}" with current value ${fmt(plan.coverage_amount)} (IDV)?\n\nThis asset will be linked to this insurance policy and will count towards your net worth.`)) return;
    try {
      await api.createAssetFromInsurance(plan.id);
      load();
    } catch (e) {
      alert(e.message);
    }
  }

  async function createFundAccount(plan) {
    const accountName = `${plan.name} – Fund`;
    if (!confirm(`Create a brokerage account "${accountName}" with balance ${fmt(plan.fund_value)}?\n\nThis account will be linked to this insurance plan and its balance will count towards your net worth. The balance will stay in sync when you update the fund value.`)) return;
    try {
      await api.createFundAccountFromInsurance(plan.id);
      load();
    } catch (e) {
      alert(e.message);
    }
  }

  async function runQuery() {
    if (!queryText.trim()) return setQueryError('Please describe your situation.');
    try {
      setQueryLoading(true); setQueryError(''); setQueryResult(null);
      const result = await api.queryInsuranceCoverage(queryText);
      setQueryResult(result);
    } catch (e) {
      setQueryError(e.message);
    } finally {
      setQueryLoading(false);
    }
  }

  async function runAnalysis() {
    try {
      setAnalyzeLoading(true); setAnalyzeError(''); setAnalyzeResult(null);
      const result = await api.analyzeInsuranceCoverage();
      setAnalyzeResult(result);
    } catch (e) {
      setAnalyzeError(e.message);
    } finally {
      setAnalyzeLoading(false);
    }
  }

  const totalAnnual = plans.reduce((s, p) => s + (annualPremium(p) ?? 0), 0);

  if (loading) return <div className="loading-center"><div className="spinner" /></div>;

  return (
    <div>
      <div className="page-header">
        <h2>
          Insurance &amp; Plans{' '}
          <span style={{ fontSize: 14, fontWeight: 400, color: 'var(--color-text-muted)' }}>
            Annual Premiums: <strong>{fmt(totalAnnual)}</strong>
          </span>
        </h2>
        <div className="flex-gap">
          <button className="btn-ghost" onClick={() => { setShowQueryModal(true); setQueryText(''); setQueryError(''); setQueryResult(null); }}>🔍 Ask Coverage</button>
          <button className="btn-ghost" onClick={() => { setShowAnalyzeModal(true); setAnalyzeError(''); setAnalyzeResult(null); runAnalysis(); }}>📊 Analyze</button>
          <button className="btn-ghost" onClick={() => { setShowAiModal(true); setAiText(''); setAiError(''); }}>🤖 Parse from Text</button>
          <button className="btn-primary" onClick={openCreate}>+ Add Plan</button>
        </div>
      </div>

      {error && <div className="error-msg">{error}</div>}

      {plans.length === 0 ? (
        <div className="card empty-state">
          <div className="icon">🛡️</div>
          <p>No insurance plans yet. Add life, health, home, auto, and other coverage.</p>
        </div>
      ) : (
        <div className="card">
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th className="hide-mobile">Insured</th>
                  <th className="hide-mobile">Provider</th>
                  <th>Type</th>
                  <th className="hide-mobile">Policy #</th>
                  <th style={{ textAlign: 'right' }}>Premium</th>
                  <th style={{ textAlign: 'right' }}>Coverage</th>
                  <th style={{ textAlign: 'right' }} className="hide-mobile">Fund Value</th>
                  <th className="hide-mobile">Start Date</th>
                  <th>End / Renewal</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {plans.map((p) => {
                  const badge = statusBadge(p);
                  const annual = annualPremium(p);
                  const conditions = Array.isArray(p.covered_conditions) ? p.covered_conditions : [];
                  return (
                    <tr key={p.id}>
                      <td>
                        <strong>{p.name}</strong>
                        {p.notes && <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{p.notes}</div>}
                        {conditions.length > 0 && (
                          <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                            {conditions.slice(0, 3).map(c => (
                              <span key={c} style={{ fontSize: 10, background: 'var(--color-bg-alt, #f0f4ff)', color: 'var(--color-primary)', borderRadius: 8, padding: '1px 6px', border: '1px solid var(--color-border)' }}>{c}</span>
                            ))}
                            {conditions.length > 3 && <span style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>+{conditions.length - 3} more</span>}
                          </div>
                        )}
                      </td>
                      <td className="hide-mobile">{p.insured_name || '—'}</td>
                      <td className="hide-mobile">{p.provider || '—'}</td>
                      <td><span className={`badge badge-${p.type}`}>{typeLabel(p.type)}</span></td>
                      <td className="hide-mobile" style={{ fontSize: 12 }}>{p.policy_number || '—'}</td>
                      <td style={{ textAlign: 'right' }}>
                        {p.premium_amount != null ? (
                          <>
                            {fmt(p.premium_amount)}
                            <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                              {typeLabel(p.premium_frequency)}
                              {annual != null && annual > 0 && ` · ${fmt(annual)}/yr`}
                            </div>
                          </>
                        ) : '—'}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {p.coverage_amount != null ? fmt(p.coverage_amount) : '—'}
                      </td>
                      <td style={{ textAlign: 'right' }} className="hide-mobile">
                        {p.fund_value != null ? (
                          <span style={{ color: 'var(--color-success, #2e7d32)', fontWeight: 600 }}>
                            {fmt(p.fund_value)}
                          </span>
                        ) : '—'}
                      </td>
                      <td className="hide-mobile">{formatDate(p.start_date)}</td>
                      <td>
                        {p.end_date ? (
                          <div>
                            <div>{formatDate(p.end_date)}</div>
                            {p.renewal_date && (
                              <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                                Renews: {formatDate(p.renewal_date)}
                              </div>
                            )}
                          </div>
                        ) : (
                          p.renewal_date ? `Renews: ${formatDate(p.renewal_date)}` : '—'
                        )}
                      </td>
                      <td>
                        {badge ? (
                          <span style={{
                            padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600,
                            background: badge.bg, color: badge.color,
                          }}>
                            {badge.label}
                          </span>
                        ) : (
                          <span style={{ color: 'var(--color-success)', fontSize: 12 }}>Active</span>
                        )}
                      </td>
                      <td>
                        <div className="flex-gap">
                          {p.type === 'auto' && p.coverage_amount != null && !p.linked_asset_id && (
                            <button
                              className="btn-ghost btn-sm"
                              title="Create a vehicle asset using this policy's IDV"
                              onClick={() => createVehicleAsset(p)}
                            >🚗 Create Asset</button>
                          )}
                          {p.linked_asset_id && (
                            <span
                              title="A vehicle asset has been created from this policy's IDV"
                              style={{ fontSize: 11, color: 'var(--color-success)', fontWeight: 600, padding: '2px 6px', border: '1px solid var(--color-success)', borderRadius: 8 }}
                            >🔗 Asset Linked</span>
                          )}
                          {p.fund_value != null && !p.linked_account_id && (
                            <button
                              className="btn-ghost btn-sm"
                              title="Create a brokerage account to track this policy's fund value in net worth"
                              onClick={() => createFundAccount(p)}
                            >📈 Track Fund</button>
                          )}
                          {p.linked_account_id && (
                            <span
                              title="A fund account has been created and linked to this insurance plan. Its balance counts towards net worth."
                              style={{ fontSize: 11, color: 'var(--color-primary)', fontWeight: 600, padding: '2px 6px', border: '1px solid var(--color-primary)', borderRadius: 8 }}
                            >📈 Fund Linked</span>
                          )}
                          <button className="btn-ghost btn-sm" onClick={() => openEdit(p)}>Edit</button>
                          <button className="btn-danger btn-sm" onClick={() => remove(p.id)}>Delete</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Add / Edit Plan Modal ─────────────────────────────────────────────── */}
      {showModal && (
        <div className="modal-backdrop" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 680 }}>
            <h3>{editing ? 'Edit Insurance Plan' : 'Add Insurance Plan'}</h3>
            {error && <div className="error-msg">{error}</div>}

            <div className="form-row">
              <div className="form-group">
                <label>Name *</label>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Life Insurance Policy" />
              </div>
              <div className="form-group">
                <label>Insured Name</label>
                <input value={form.insured_name} onChange={(e) => setForm({ ...form, insured_name: e.target.value })} placeholder="e.g. Self, Spouse, Child" />
              </div>
              <div className="form-group">
                <label>Provider</label>
                <input value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })} placeholder="Prudential" />
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label>Type</label>
                <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                  {INSURANCE_TYPES.map((t) => <option key={t} value={t}>{typeLabel(t)}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label>Policy Number</label>
                <input value={form.policy_number} onChange={(e) => setForm({ ...form, policy_number: e.target.value })} placeholder="POL-123456" />
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label>Premium Amount{currency ? ` (${currency})` : ''}</label>
                <input type="number" step="0.01" value={form.premium_amount} onChange={(e) => setForm({ ...form, premium_amount: e.target.value })} placeholder="150" />
              </div>
              <div className="form-group">
                <label>Premium Frequency</label>
                <select value={form.premium_frequency} onChange={(e) => setForm({ ...form, premium_frequency: e.target.value })}>
                  {FREQUENCIES.map((f) => <option key={f} value={f}>{typeLabel(f)}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label>Coverage Amount{currency ? ` (${currency})` : ''}</label>
                <input type="number" value={form.coverage_amount} onChange={(e) => setForm({ ...form, coverage_amount: e.target.value })} placeholder="500000" />
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label>Fund Value{currency ? ` (${currency})` : ''}</label>
                <input
                  type="number"
                  step="0.01"
                  value={form.fund_value}
                  onChange={(e) => setForm({ ...form, fund_value: e.target.value })}
                  placeholder="Current market value of investment component (e.g. ULIP)"
                />
                <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 3 }}>
                  For market-linked policies (ULIP, endowment, etc.) — the current fund / NAV value.
                  Leave blank for pure-protection plans.
                </div>
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label>Start Date</label>
                <input type="date" value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} />
              </div>
              <div className="form-group">
                <label>End Date</label>
                <input type="date" value={form.end_date} onChange={(e) => setForm({ ...form, end_date: e.target.value })} />
              </div>
              <div className="form-group">
                <label>Next Renewal Date</label>
                <input type="date" value={form.renewal_date} onChange={(e) => setForm({ ...form, renewal_date: e.target.value })} />
              </div>
            </div>

            <div className="form-group mb-4">
              <label>Notes</label>
              <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} />
            </div>

            {/* ── Coverage Details (collapsible) ─────────────────────────────── */}
            <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: 12, marginBottom: 12 }}>
              <button
                type="button"
                className="btn-ghost"
                style={{ fontSize: 13, padding: '4px 0', marginBottom: showCoverageDetails ? 12 : 0 }}
                onClick={() => setShowCoverageDetails(v => !v)}
              >
                {showCoverageDetails ? '▾' : '▸'} Coverage Details (terms &amp; conditions)
              </button>

              {showCoverageDetails && (
                <>
                  <div className="form-group mb-4">
                    <label>Policy Terms / Key Inclusions &amp; Exclusions</label>
                    <textarea
                      value={form.terms}
                      onChange={(e) => setForm({ ...form, terms: e.target.value })}
                      rows={6}
                      placeholder="Paste policy document text, key inclusions, exclusions, waiting periods, sub-limits, etc. This text is used by the AI coverage query feature."
                      style={{ fontFamily: 'monospace', fontSize: 12 }}
                    />
                  </div>

                  <div className="form-group mb-4">
                    <label>Covered Conditions / Tags</label>
                    <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                      <input
                        value={conditionInput}
                        onChange={(e) => setConditionInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addConditionTag(); } }}
                        placeholder="e.g. Hospitalisation, Surgery, Cancer…"
                        style={{ flex: 1 }}
                      />
                      <button type="button" className="btn-ghost btn-sm" onClick={addConditionTag}>Add</button>
                    </div>
                    {form.covered_conditions.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {form.covered_conditions.map(tag => (
                          <span key={tag} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'var(--color-bg-alt, #f0f4ff)', color: 'var(--color-primary)', border: '1px solid var(--color-border)', borderRadius: 12, padding: '2px 10px', fontSize: 12 }}>
                            {tag}
                            <button type="button" onClick={() => removeConditionTag(tag)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 0, color: 'inherit' }}>×</button>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>

            <div className="modal-actions">
              <button className="btn-ghost" onClick={() => setShowModal(false)}>Cancel</button>
              <button className="btn-primary" onClick={save}>Save</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Parse from Text Modal ─────────────────────────────────────────────── */}
      {showAiModal && (
        <div className="modal-backdrop" onClick={() => setShowAiModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
            <h3>🤖 Parse Insurance from Text</h3>
            <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 12 }}>
              Paste text from an insurance document, policy email, or any description. AI will extract the details and pre-fill the form. The pasted text will also be saved as the policy terms for future coverage queries.
            </p>
            {aiError && <div className="error-msg">{aiError}</div>}
            <div className="form-group mb-4">
              <label>Insurance document text</label>
              <textarea
                rows={10}
                value={aiText}
                onChange={(e) => setAiText(e.target.value)}
                placeholder="Paste your insurance policy details, renewal notice, or any text describing your coverage here…"
                style={{ fontFamily: 'monospace', fontSize: 12 }}
              />
            </div>
            <div className="modal-actions">
              <button className="btn-ghost" onClick={() => setShowAiModal(false)} disabled={aiLoading}>Cancel</button>
              <button className="btn-primary" onClick={parseFromText} disabled={aiLoading || !aiText.trim()}>
                {aiLoading ? <><span className="spinner" style={{ width: 14, height: 14 }} /> Parsing…</> : '🤖 Extract & Fill Form'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Ask Coverage Modal ────────────────────────────────────────────────── */}
      {showQueryModal && (
        <div className="modal-backdrop" onClick={() => setShowQueryModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 600 }}>
            <h3>🔍 Ask Coverage</h3>
            <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 12 }}>
              Describe your situation and AI will tell you which of your insurance plans apply and in what order.
            </p>
            {queryError && <div className="error-msg">{queryError}</div>}
            <div className="form-group mb-4">
              <label>Describe your situation</label>
              <textarea
                rows={4}
                value={queryText}
                onChange={(e) => setQueryText(e.target.value)}
                placeholder="e.g. I was hospitalised overnight for a fever. Which plan should I claim from first?"
              />
            </div>
            <div className="modal-actions" style={{ marginBottom: queryResult ? 16 : 0 }}>
              <button className="btn-ghost" onClick={() => setShowQueryModal(false)} disabled={queryLoading}>Close</button>
              <button className="btn-primary" onClick={runQuery} disabled={queryLoading || !queryText.trim()}>
                {queryLoading ? <><span className="spinner" style={{ width: 14, height: 14 }} /> Asking…</> : '🔍 Ask'}
              </button>
            </div>
            {queryResult && (
              <div style={{ marginTop: 16 }}>
                <div style={{ background: 'var(--color-bg-alt, #f8f9fa)', borderRadius: 8, padding: '12px 16px', marginBottom: 12, fontSize: 14, lineHeight: 1.6 }}>
                  {queryResult.answer}
                </div>
                {queryResult.applicable_plans && queryResult.applicable_plans.length > 0 && (
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>Applicable Plans</div>
                    {queryResult.applicable_plans.map((p) => (
                      <div key={p.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '8px 0', borderBottom: '1px solid var(--color-border)' }}>
                        <span style={{ minWidth: 22, height: 22, borderRadius: '50%', background: 'var(--color-primary)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700 }}>{p.priority}</span>
                        <div>
                          <div style={{ fontWeight: 600, fontSize: 14 }}>{p.name}</div>
                          <div style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>{p.reason}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Analyze Coverage Modal ────────────────────────────────────────────── */}
      {showAnalyzeModal && (
        <div className="modal-backdrop" onClick={() => setShowAnalyzeModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 640 }}>
            <h3>📊 Coverage Analysis</h3>
            {analyzeLoading && (
              <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--color-text-muted)' }}>
                <div className="spinner" style={{ margin: '0 auto 12px' }} />
                Analyzing your insurance portfolio…
              </div>
            )}
            {analyzeError && <div className="error-msg">{analyzeError}</div>}
            {analyzeResult && (
              <div>
                <AnalysisSection icon="🔄" title="Overlaps" items={analyzeResult.overlaps} emptyMsg="No overlaps detected." color="var(--color-warning, #e65100)" />
                <AnalysisSection icon="⚠️" title="Coverage Gaps" items={analyzeResult.gaps} emptyMsg="No obvious gaps detected." color="var(--color-danger, #b71c1c)" />
                <AnalysisSection icon="💡" title="Optimization Suggestions" items={analyzeResult.suggestions} emptyMsg="No suggestions." color="var(--color-success, #2e7d32)" />
              </div>
            )}
            <div className="modal-actions" style={{ marginTop: 16 }}>
              <button className="btn-ghost" onClick={() => setShowAnalyzeModal(false)}>Close</button>
              {!analyzeLoading && <button className="btn-ghost" onClick={() => { setAnalyzeResult(null); setAnalyzeError(''); runAnalysis(); }}>↺ Re-analyse</button>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AnalysisSection({ icon, title, items, emptyMsg, color }) {
  const [open, setOpen] = useState(true);
  return (
    <div style={{ marginBottom: 16 }}>
      <button
        type="button"
        className="btn-ghost"
        style={{ fontWeight: 600, fontSize: 14, padding: '4px 0', display: 'flex', alignItems: 'center', gap: 6, color }}
        onClick={() => setOpen(v => !v)}
      >
        {open ? '▾' : '▸'} {icon} {title}
        <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--color-text-muted)', marginLeft: 4 }}>({items.length})</span>
      </button>
      {open && (
        <ul style={{ margin: '6px 0 0 24px', padding: 0, listStyle: 'disc' }}>
          {items.length === 0
            ? <li style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>{emptyMsg}</li>
            : items.map((item, i) => (
              <li key={i} style={{ fontSize: 13, marginBottom: 4, lineHeight: 1.5 }}>{item}</li>
            ))
          }
        </ul>
      )}
    </div>
  );
}

