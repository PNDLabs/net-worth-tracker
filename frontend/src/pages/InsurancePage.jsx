import { useEffect, useState } from 'react';
import { api } from '../hooks/api';
import { formatCurrency, formatDate, typeLabel } from '../hooks/format';

const INSURANCE_TYPES = [
  'life', 'term_life', 'health', 'dental', 'vision', 'auto', 'home',
  'renters', 'disability', 'umbrella', 'travel', 'pet', 'business', 'other',
];
const FREQUENCIES = ['monthly', 'quarterly', 'semi_annual', 'annual', 'one_time'];

const EMPTY = {
  name: '', provider: '', type: 'other', policy_number: '',
  premium_amount: '', premium_frequency: 'monthly', coverage_amount: '',
  start_date: '', end_date: '', renewal_date: '', notes: '',
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

  const load = () =>
    api.getInsurance().then(setPlans).catch(e => setError(e.message)).finally(() => setLoading(false));
  useEffect(() => { load(); }, []);

  function openCreate() { setEditing(null); setForm(EMPTY); setShowModal(true); setError(''); }
  function openEdit(p) {
    setEditing(p);
    setForm({
      ...p,
      premium_amount: p.premium_amount ?? '',
      coverage_amount: p.coverage_amount ?? '',
      start_date: p.start_date || '',
      end_date: p.end_date || '',
      renewal_date: p.renewal_date || '',
      policy_number: p.policy_number || '',
      provider: p.provider || '',
      notes: p.notes || '',
    });
    setShowModal(true);
    setError('');
  }

  async function save() {
    try {
      setError('');
      const payload = {
        ...form,
        premium_amount: form.premium_amount !== '' ? Number(form.premium_amount) : null,
        coverage_amount: form.coverage_amount !== '' ? Number(form.coverage_amount) : null,
        start_date: form.start_date || null,
        end_date: form.end_date || null,
        renewal_date: form.renewal_date || null,
        policy_number: form.policy_number || null,
        provider: form.provider || null,
        notes: form.notes || null,
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

  const totalAnnual = plans.reduce((s, p) => s + (annualPremium(p) ?? 0), 0);

  if (loading) return <div className="loading-center"><div className="spinner" /></div>;

  return (
    <div>
      <div className="page-header">
        <h2>
          Insurance &amp; Plans{' '}
          <span style={{ fontSize: 14, fontWeight: 400, color: 'var(--color-text-muted)' }}>
            Annual Premiums: <strong>{formatCurrency(totalAnnual)}</strong>
          </span>
        </h2>
        <button className="btn-primary" onClick={openCreate}>+ Add Plan</button>
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
                  <th>Provider</th>
                  <th>Type</th>
                  <th>Policy #</th>
                  <th style={{ textAlign: 'right' }}>Premium</th>
                  <th style={{ textAlign: 'right' }}>Coverage</th>
                  <th>Start Date</th>
                  <th>End / Renewal</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {plans.map((p) => {
                  const badge = statusBadge(p);
                  const annual = annualPremium(p);
                  return (
                    <tr key={p.id}>
                      <td>
                        <strong>{p.name}</strong>
                        {p.notes && <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{p.notes}</div>}
                      </td>
                      <td>{p.provider || '—'}</td>
                      <td><span className={`badge badge-${p.type}`}>{typeLabel(p.type)}</span></td>
                      <td style={{ fontSize: 12 }}>{p.policy_number || '—'}</td>
                      <td style={{ textAlign: 'right' }}>
                        {p.premium_amount != null ? (
                          <>
                            {formatCurrency(p.premium_amount)}
                            <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                              {typeLabel(p.premium_frequency)}
                              {annual != null && annual > 0 && ` · ${formatCurrency(annual)}/yr`}
                            </div>
                          </>
                        ) : '—'}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {p.coverage_amount != null ? formatCurrency(p.coverage_amount) : '—'}
                      </td>
                      <td>{formatDate(p.start_date)}</td>
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

      {showModal && (
        <div className="modal-backdrop" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{editing ? 'Edit Insurance Plan' : 'Add Insurance Plan'}</h3>
            {error && <div className="error-msg">{error}</div>}

            <div className="form-row">
              <div className="form-group">
                <label>Name *</label>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Life Insurance Policy" />
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
                <label>Premium Amount ($)</label>
                <input type="number" step="0.01" value={form.premium_amount} onChange={(e) => setForm({ ...form, premium_amount: e.target.value })} placeholder="150" />
              </div>
              <div className="form-group">
                <label>Premium Frequency</label>
                <select value={form.premium_frequency} onChange={(e) => setForm({ ...form, premium_frequency: e.target.value })}>
                  {FREQUENCIES.map((f) => <option key={f} value={f}>{typeLabel(f)}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label>Coverage Amount ($)</label>
                <input type="number" value={form.coverage_amount} onChange={(e) => setForm({ ...form, coverage_amount: e.target.value })} placeholder="500000" />
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

            <div className="modal-actions">
              <button className="btn-ghost" onClick={() => setShowModal(false)}>Cancel</button>
              <button className="btn-primary" onClick={save}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
