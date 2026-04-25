import { useEffect, useState } from 'react';
import { api } from '../hooks/apiAdapter';
import { formatCurrency, formatDate, formatPct, typeLabel } from '../hooks/format';
import { useCurrency } from '../hooks/CurrencyContext';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

const LIABILITY_TYPES = ['mortgage', 'auto', 'student', 'personal', 'credit_card', 'heloc', 'other'];
const EMPTY = { name: '', lender: '', type: 'other', original_principal: '', current_balance: '', interest_rate: '', minimum_payment: '', notes: '' };

export default function LiabilitiesPage() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [historyId, setHistoryId] = useState(null);
  const [historyData, setHistoryData] = useState({});

  const load = () => api.getLiabilities().then(setItems).catch(e => setError(e.message)).finally(() => setLoading(false));
  useEffect(() => { load(); }, []);
  const { currency } = useCurrency();
  const fmt = (v) => formatCurrency(v, currency);

  function openCreate() { setEditing(null); setForm(EMPTY); setShowModal(true); setError(''); }
  function openEdit(l) {
    setEditing(l);
    setForm({ ...l, original_principal: l.original_principal ?? '', interest_rate: l.interest_rate ?? '', minimum_payment: l.minimum_payment ?? '', notes: l.notes || '' });
    setShowModal(true); setError('');
  }

  async function save() {
    try {
      setError('');
      const payload = {
        ...form,
        original_principal: form.original_principal !== '' ? Number(form.original_principal) : null,
        current_balance: Number(form.current_balance),
        interest_rate: form.interest_rate !== '' ? Number(form.interest_rate) : null,
        minimum_payment: form.minimum_payment !== '' ? Number(form.minimum_payment) : null,
      };
      if (editing) await api.updateLiability(editing.id, payload);
      else await api.createLiability(payload);
      setShowModal(false); load();
    } catch (e) { setError(e.message); }
  }

  async function remove(id) {
    if (!confirm('Delete this liability?')) return;
    try { await api.deleteLiability(id); load(); }
    catch (e) { setError(e.message); }
  }

  async function toggleHistory(id) {
    if (historyId === id) { setHistoryId(null); return; }
    setHistoryId(id);
    if (!historyData[id]) {
      const [hist, growth] = await Promise.all([
        api.getValueHistory('liability', id).catch(() => []),
        api.getValueGrowth('liability', id).catch(() => null),
      ]);
      setHistoryData((prev) => ({ ...prev, [id]: { hist, growth } }));
    }
  }

  const total = items.reduce((s, l) => s + l.current_balance, 0);

  if (loading) return <div className="loading-center"><div className="spinner" /></div>;

  return (
    <div>
      <div className="page-header">
        <h2>Liabilities <span style={{ fontSize: 14, fontWeight: 400, color: 'var(--color-text-muted)' }}>Total: <strong style={{ color: 'var(--color-danger)' }}>{fmt(total)}</strong></span></h2>
        <button className="btn-primary" onClick={openCreate}>+ Add Liability</button>
      </div>

      {error && <div className="error-msg">{error}</div>}

      {items.length === 0 ? (
        <div className="card empty-state">
          <div className="icon">💳</div>
          <p>No liabilities yet. Add mortgages, loans, and credit card balances.</p>
        </div>
      ) : (
        <div className="card">
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>Name</th><th>Lender</th><th>Type</th>
                  <th style={{ textAlign: 'right' }}>Original</th>
                  <th style={{ textAlign: 'right' }}>Balance</th>
                  <th style={{ textAlign: 'right' }}>Rate</th>
                  <th style={{ textAlign: 'right' }}>Min. Payment</th>
                  <th style={{ textAlign: 'right' }}>Paid Off</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((l) => {
                  const pct = l.original_principal ? ((l.original_principal - l.current_balance) / l.original_principal) * 100 : null;
                  return (
                    <>
                      <tr key={l.id}>
                        <td><strong>{l.name}</strong>{l.notes && <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{l.notes}</div>}</td>
                        <td>{l.lender || '—'}</td>
                        <td><span className={`badge badge-${l.type}`}>{typeLabel(l.type)}</span></td>
                        <td style={{ textAlign: 'right' }}>{l.original_principal != null ? fmt(l.original_principal) : '—'}</td>
                        <td style={{ textAlign: 'right' }} className="amount negative">{fmt(l.current_balance)}</td>
                        <td style={{ textAlign: 'right' }}>{l.interest_rate != null ? formatPct(l.interest_rate) : '—'}</td>
                        <td style={{ textAlign: 'right' }}>{l.minimum_payment != null ? fmt(l.minimum_payment) : '—'}</td>
                        <td style={{ textAlign: 'right' }}>{pct != null ? `${pct.toFixed(1)}%` : '—'}</td>
                        <td>
                          <div className="flex-gap">
                            <button className="btn-ghost btn-sm" onClick={() => openEdit(l)}>Edit</button>
                            <button className="btn-danger btn-sm" onClick={() => remove(l.id)}>Delete</button>
                            <button className="btn-ghost btn-sm" onClick={() => toggleHistory(l.id)}>📈 History</button>
                          </div>
                        </td>
                      </tr>
                      {historyId === l.id && (
                        <tr key={`vh-${l.id}`}>
                          <td colSpan={9} style={{ padding: '12px 24px', background: 'var(--color-surface-2)' }}>
                            {(() => {
                              const d = historyData[l.id];
                              if (!d) return <p style={{ color: 'var(--color-text-muted)' }}>Loading history…</p>;
                              const g = d.growth;
                              return (
                                <>
                                  {g && g.data_points > 0 && (
                                    <div style={{ display: 'flex', gap: 24, marginBottom: 12, flexWrap: 'wrap' }}>
                                      <span>Initial: <strong>{fmt(g.first_value)}</strong> ({formatDate(g.first_date)})</span>
                                      <span>Current: <strong>{fmt(g.latest_value)}</strong> ({formatDate(g.latest_date)})</span>
                                      <span style={{ color: g.absolute_change <= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                                        Change: <strong>{g.absolute_change >= 0 ? '+' : ''}{fmt(g.absolute_change)}</strong>
                                        {g.percent_change != null && <> ({g.percent_change >= 0 ? '+' : ''}{g.percent_change}%)</>}
                                      </span>
                                    </div>
                                  )}
                                  {d.hist.length > 1 ? (
                                    <ResponsiveContainer width="100%" height={180}>
                                      <LineChart data={d.hist} margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
                                        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                                        <XAxis dataKey="recorded_at" tick={{ fontSize: 10 }} />
                                        <YAxis tickFormatter={(v) => fmt(v)} tick={{ fontSize: 10 }} />
                                        <Tooltip formatter={(v) => fmt(v)} />
                                        <Line type="monotone" dataKey="value" name="Balance" stroke="#d73a49" strokeWidth={2} dot />
                                      </LineChart>
                                    </ResponsiveContainer>
                                  ) : d.hist.length === 1 ? (
                                    <p style={{ color: 'var(--color-text-muted)' }}>Only one data point. Update the balance to see a trend.</p>
                                  ) : (
                                    <p style={{ color: 'var(--color-text-muted)' }}>No history recorded yet.</p>
                                  )}
                                </>
                              );
                            })()}
                          </td>
                        </tr>
                      )}
                    </>
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
            <h3>{editing ? 'Edit Liability' : 'Add Liability'}</h3>
            {error && <div className="error-msg">{error}</div>}
            <div className="form-row">
              <div className="form-group">
                <label>Name *</label>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Home Mortgage" />
              </div>
              <div className="form-group">
                <label>Lender</label>
                <input value={form.lender} onChange={(e) => setForm({ ...form, lender: e.target.value })} placeholder="Wells Fargo" />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Type</label>
                <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                  {LIABILITY_TYPES.map((t) => <option key={t} value={t}>{typeLabel(t)}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label>Original Principal{currency ? ` (${currency})` : ''}</label>
                <input type="number" value={form.original_principal} onChange={(e) => setForm({ ...form, original_principal: e.target.value })} placeholder="400000" />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Current Balance{currency ? ` (${currency})` : ''} *</label>
                <input type="number" value={form.current_balance} onChange={(e) => setForm({ ...form, current_balance: e.target.value })} placeholder="380000" />
              </div>
              <div className="form-group">
                <label>Interest Rate (%)</label>
                <input type="number" step="0.01" value={form.interest_rate} onChange={(e) => setForm({ ...form, interest_rate: e.target.value })} placeholder="3.5" />
              </div>
              <div className="form-group">
                <label>Min. Payment{currency ? ` (${currency}/mo)` : ' (per month)'}</label>
                <input type="number" value={form.minimum_payment} onChange={(e) => setForm({ ...form, minimum_payment: e.target.value })} placeholder="1800" />
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
