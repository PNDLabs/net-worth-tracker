import { useEffect, useState } from 'react';
import { api } from '../hooks/apiAdapter';
import { formatCurrency, formatDate, typeLabel } from '../hooks/format';
import { useCurrency } from '../hooks/CurrencyContext';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

const CATEGORIES = ['real_estate', 'vehicle', 'crypto', 'collectible', 'business', 'other'];
const EMPTY = { name: '', category: 'other', acquisition_date: '', acquisition_cost: '', current_value: '', notes: '' };

export default function AssetsPage() {
  const [assets, setAssets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [historyId, setHistoryId] = useState(null);
  const [historyData, setHistoryData] = useState({});
  const { currency } = useCurrency();
  const fmt = (v) => formatCurrency(v, currency);

  const load = () => api.getAssets().then(setAssets).catch(e => setError(e.message)).finally(() => setLoading(false));
  useEffect(() => { load(); }, []);

  function openCreate() { setEditing(null); setForm(EMPTY); setShowModal(true); setError(''); }
  function openEdit(a) { setEditing(a); setForm({ ...a, acquisition_date: a.acquisition_date || '', acquisition_cost: a.acquisition_cost ?? '', current_value: a.current_value, notes: a.notes || '' }); setShowModal(true); setError(''); }

  async function save() {
    try {
      setError('');
      const payload = { ...form, acquisition_cost: form.acquisition_cost !== '' ? Number(form.acquisition_cost) : null, current_value: Number(form.current_value), acquisition_date: form.acquisition_date || null };
      if (editing) await api.updateAsset(editing.id, payload);
      else await api.createAsset(payload);
      setShowModal(false); load();
    } catch (e) { setError(e.message); }
  }

  async function remove(id) {
    if (!confirm('Delete this asset?')) return;
    try { await api.deleteAsset(id); load(); }
    catch (e) { setError(e.message); }
  }

  async function toggleHistory(id) {
    if (historyId === id) { setHistoryId(null); return; }
    setHistoryId(id);
    if (!historyData[id]) {
      const [hist, growth] = await Promise.all([
        api.getValueHistory('asset', id).catch(() => []),
        api.getValueGrowth('asset', id).catch(() => null),
      ]);
      setHistoryData((prev) => ({ ...prev, [id]: { hist, growth } }));
    }
  }

  const total = assets.reduce((s, a) => s + a.current_value, 0);

  if (loading) return <div className="loading-center"><div className="spinner" /></div>;

  return (
    <div>
      <div className="page-header">
        <h2>Assets <span style={{ fontSize: 14, fontWeight: 400, color: 'var(--color-text-muted)' }}>Total: <strong>{fmt(total)}</strong></span></h2>
        <button className="btn-primary" onClick={openCreate}>+ Add Asset</button>
      </div>

      {error && <div className="error-msg">{error}</div>}

      {assets.length === 0 ? (
        <div className="card empty-state">
          <div className="icon">🏠</div>
          <p>No assets yet. Add real estate, vehicles, crypto, and more.</p>
        </div>
      ) : (
        <div className="card">
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>Name</th><th>Category</th><th>Acquired</th>
                  <th style={{ textAlign: 'right' }}>Cost Basis</th>
                  <th style={{ textAlign: 'right' }}>Current Value</th>
                  <th style={{ textAlign: 'right' }}>Gain/Loss</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {assets.map((a) => {
                  const gl = a.acquisition_cost != null ? a.current_value - a.acquisition_cost : null;
                  return (
                    <>
                      <tr key={a.id}>
                        <td><strong>{a.name}</strong>{a.notes && <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{a.notes}</div>}</td>
                        <td><span className={`badge badge-${a.category}`}>{typeLabel(a.category)}</span></td>
                        <td>{formatDate(a.acquisition_date)}</td>
                        <td style={{ textAlign: 'right' }}>{a.acquisition_cost != null ? fmt(a.acquisition_cost) : '—'}</td>
                        <td style={{ textAlign: 'right' }} className="amount positive">{fmt(a.current_value)}</td>
                        <td style={{ textAlign: 'right' }} className={`amount ${gl == null ? '' : gl >= 0 ? 'positive' : 'negative'}`}>
                          {gl != null ? `${gl >= 0 ? '+' : ''}${fmt(gl)}` : '—'}
                        </td>
                        <td>
                          <div className="flex-gap">
                            <button className="btn-ghost btn-sm" onClick={() => openEdit(a)}>Edit</button>
                            <button className="btn-danger btn-sm" onClick={() => remove(a.id)}>Delete</button>
                            <button className="btn-ghost btn-sm" onClick={() => toggleHistory(a.id)}>📈 History</button>
                          </div>
                        </td>
                      </tr>
                      {historyId === a.id && (
                        <tr key={`vh-${a.id}`}>
                          <td colSpan={7} style={{ padding: '12px 24px', background: 'var(--color-surface-2)' }}>
                            {(() => {
                              const d = historyData[a.id];
                              if (!d) return <p style={{ color: 'var(--color-text-muted)' }}>Loading history…</p>;
                              const g = d.growth;
                              return (
                                <>
                                  {g && g.data_points > 0 && (
                                    <div style={{ display: 'flex', gap: 24, marginBottom: 12, flexWrap: 'wrap' }}>
                                      <span>First: <strong>{fmt(g.first_value)}</strong> ({formatDate(g.first_date)})</span>
                                      <span>Latest: <strong>{fmt(g.latest_value)}</strong> ({formatDate(g.latest_date)})</span>
                                      <span style={{ color: g.absolute_change >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
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
                                        <Line type="monotone" dataKey="value" name="Value" stroke="#28a745" strokeWidth={2} dot />
                                      </LineChart>
                                    </ResponsiveContainer>
                                  ) : d.hist.length === 1 ? (
                                    <p style={{ color: 'var(--color-text-muted)' }}>Only one data point. Update the value to see a trend.</p>
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
            <h3>{editing ? 'Edit Asset' : 'Add Asset'}</h3>
            {error && <div className="error-msg">{error}</div>}
            <div className="form-row">
              <div className="form-group">
                <label>Name *</label>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Primary Residence" />
              </div>
              <div className="form-group">
                <label>Category</label>
                <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                  {CATEGORIES.map((c) => <option key={c} value={c}>{typeLabel(c)}</option>)}
                </select>
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Acquisition Date</label>
                <input type="date" value={form.acquisition_date} onChange={(e) => setForm({ ...form, acquisition_date: e.target.value })} />
              </div>
              <div className="form-group">
                <label>Cost Basis{currency ? ` (${currency})` : ''}</label>
                <input type="number" value={form.acquisition_cost} onChange={(e) => setForm({ ...form, acquisition_cost: e.target.value })} placeholder="300000" />
              </div>
              <div className="form-group">
                <label>Current Value{currency ? ` (${currency})` : ''} *</label>
                <input type="number" value={form.current_value} onChange={(e) => setForm({ ...form, current_value: e.target.value })} placeholder="350000" />
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
