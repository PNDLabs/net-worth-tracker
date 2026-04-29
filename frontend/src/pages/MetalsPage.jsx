import { useEffect, useState } from 'react';
import { api } from '../hooks/apiAdapter';
import { formatCurrency, formatDate, typeLabel } from '../hooks/format';
import { useCurrency } from '../hooks/CurrencyContext';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

const METAL_TYPES = ['gold', 'silver', 'platinum', 'palladium'];
const METAL_FORMS = ['physical', 'digital'];

const METAL_ICONS = { gold: '🥇', silver: '🥈', platinum: '⬜', palladium: '🔘' };

const PURITY_PRESETS = {
  gold: ['24k', '22k', '18k', '14k', '10k', '999.9', '999'],
  silver: ['999', '925', '900', '800'],
  platinum: ['999.5', '950', '900', '850'],
  palladium: ['999.5', '950'],
};

const EMPTY = {
  name: '', metal_type: 'gold', metal_form: 'physical',
  purity: '', quantity_grams: '', acquisition_date: '',
  acquisition_cost: '', current_price_gram: '', notes: '',
};

export default function MetalsPage() {
  const [metals, setMetals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [historyId, setHistoryId] = useState(null);
  const [historyData, setHistoryData] = useState({});
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState('');
  const [spotPrices, setSpotPrices] = useState(null);
  const { currency } = useCurrency();
  const fmt = (v) => formatCurrency(v, currency);

  const load = () =>
    api.getMetals().then(setMetals).catch((e) => setError(e.message)).finally(() => setLoading(false));

  useEffect(() => { load(); }, []);

  function openCreate() { setEditing(null); setForm(EMPTY); setShowModal(true); setError(''); }
  function openEdit(m) {
    setEditing(m);
    setForm({
      name: m.name,
      metal_type: m.metal_type,
      metal_form: m.metal_form,
      purity: m.purity || '',
      quantity_grams: m.quantity_grams,
      acquisition_date: m.acquisition_date || '',
      acquisition_cost: m.acquisition_cost ?? '',
      current_price_gram: m.current_price_gram ?? '',
      notes: m.notes || '',
    });
    setShowModal(true);
    setError('');
  }

  async function save() {
    try {
      setError('');
      const payload = {
        ...form,
        quantity_grams: Number(form.quantity_grams) || 0,
        acquisition_cost: form.acquisition_cost !== '' ? Number(form.acquisition_cost) : null,
        current_price_gram: form.current_price_gram !== '' ? Number(form.current_price_gram) : null,
        acquisition_date: form.acquisition_date || null,
        purity: form.purity || null,
      };
      if (editing) await api.updateMetal(editing.id, payload);
      else await api.createMetal(payload);
      setShowModal(false);
      load();
    } catch (e) { setError(e.message); }
  }

  async function remove(id) {
    if (!confirm('Delete this metal holding?')) return;
    try { await api.deleteMetal(id); load(); }
    catch (e) { setError(e.message); }
  }

  async function handleRefreshPrices() {
    setRefreshing(true);
    setRefreshMsg('');
    try {
      const result = await api.refreshMetalPrices();
      const priceLines = Object.entries(result.prices || {})
        .map(([m, p]) => `${m}: ${fmt(p)}/g`)
        .join(' · ');
      setRefreshMsg(`✅ Updated ${result.updated} holding(s). ${priceLines}`);
      load();
    } catch (e) {
      setRefreshMsg(`❌ ${e.message}`);
    } finally {
      setRefreshing(false);
      setTimeout(() => setRefreshMsg(''), 8000);
    }
  }

  async function toggleHistory(id) {
    if (historyId === id) { setHistoryId(null); return; }
    setHistoryId(id);
    if (!historyData[id]) {
      const [hist, growth] = await Promise.all([
        api.getValueHistory('metal', id).catch(() => []),
        api.getValueGrowth('metal', id).catch(() => null),
      ]);
      setHistoryData((prev) => ({ ...prev, [id]: { hist, growth } }));
    }
  }

  const total = metals.reduce((s, m) => s + m.current_value, 0);

  // Group by metal type for a summary
  const byType = METAL_TYPES.reduce((acc, t) => {
    const group = metals.filter((m) => m.metal_type === t);
    if (group.length) acc[t] = { count: group.length, value: group.reduce((s, m) => s + m.current_value, 0) };
    return acc;
  }, {});

  if (loading) return <div className="loading-center"><div className="spinner" /></div>;

  return (
    <div>
      <div className="page-header">
        <h2>
          Precious Metals{' '}
          <span style={{ fontSize: 14, fontWeight: 400, color: 'var(--color-text-muted)' }}>
            Total: <strong>{fmt(total)}</strong>
          </span>
        </h2>
        <div className="flex-gap">
          <button
            className="btn-ghost"
            onClick={handleRefreshPrices}
            disabled={refreshing}
            title="Fetch live spot prices from api.metalpriceapi.com and update holdings"
          >
            {refreshing ? '⏳ Refreshing…' : '🔄 Refresh Prices'}
          </button>
          <button className="btn-primary" onClick={openCreate}>+ Add Holding</button>
        </div>
      </div>

      {refreshMsg && (
        <div className={`${refreshMsg.startsWith('❌') ? 'error-msg' : 'success-msg'}`} style={{ marginBottom: 12 }}>
          {refreshMsg}
        </div>
      )}
      {error && <div className="error-msg">{error}</div>}

      {/* Type summary cards */}
      {Object.keys(byType).length > 0 && (
        <div className="card-grid" style={{ marginBottom: 16 }}>
          {Object.entries(byType).map(([type, info]) => (
            <div key={type} className="card stat-card assets" style={{ padding: '12px 16px' }}>
              <div className="label">{METAL_ICONS[type]} {typeLabel(type)} ({info.count})</div>
              <div className="value" style={{ fontSize: 18 }}>{fmt(info.value)}</div>
            </div>
          ))}
        </div>
      )}

      {metals.length === 0 ? (
        <div className="card empty-state">
          <div className="icon">🥇</div>
          <p>No precious metals yet. Add gold, silver, platinum, or palladium holdings.</p>
          <p style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
            Live spot prices are sourced from api.metalpriceapi.com (in {currency}/gram). Use <strong>Refresh Prices</strong> to update values.
          </p>
        </div>
      ) : (
        <div className="card">
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type / Form</th>
                  <th className="hide-mobile">Purity</th>
                  <th style={{ textAlign: 'right' }}>Qty (g)</th>
                  <th className="hide-mobile" style={{ textAlign: 'right' }}>Price/g</th>
                  <th style={{ textAlign: 'right' }}>Current Value</th>
                  <th className="hide-mobile" style={{ textAlign: 'right' }}>Cost Basis</th>
                  <th style={{ textAlign: 'right' }}>Gain/Loss</th>
                  <th className="hide-mobile">Last Update</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {metals.map((m) => {
                  const gl = m.acquisition_cost != null ? m.current_value - m.acquisition_cost : null;
                  return (
                    <>
                      <tr key={m.id}>
                        <td>
                          <strong>{METAL_ICONS[m.metal_type]} {m.name}</strong>
                          {m.notes && <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{m.notes}</div>}
                        </td>
                        <td>
                          <span className="badge badge-other">{typeLabel(m.metal_type)}</span>
                          {' '}
                          <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{m.metal_form}</span>
                        </td>
                        <td className="hide-mobile">{m.purity || '—'}</td>
                        <td style={{ textAlign: 'right' }}>{m.quantity_grams}g</td>
                        <td className="hide-mobile" style={{ textAlign: 'right' }}>
                          {m.current_price_gram != null ? fmt(m.current_price_gram) : '—'}
                        </td>
                        <td style={{ textAlign: 'right' }} className="amount positive">{fmt(m.current_value)}</td>
                        <td className="hide-mobile" style={{ textAlign: 'right' }}>
                          {m.acquisition_cost != null ? fmt(m.acquisition_cost) : '—'}
                        </td>
                        <td style={{ textAlign: 'right' }} className={`amount ${gl == null ? '' : gl >= 0 ? 'positive' : 'negative'}`}>
                          {gl != null ? `${gl >= 0 ? '+' : ''}${fmt(gl)}` : '—'}
                        </td>
                        <td className="hide-mobile" style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                          {m.last_price_update
                            ? new Date(m.last_price_update).toLocaleDateString()
                            : '—'}
                        </td>
                        <td>
                          <div className="flex-gap">
                            <button className="btn-ghost btn-sm" onClick={() => openEdit(m)}>Edit</button>
                            <button className="btn-danger btn-sm" onClick={() => remove(m.id)}>Delete</button>
                            <button className="btn-ghost btn-sm" onClick={() => toggleHistory(m.id)}>📈 History</button>
                          </div>
                        </td>
                      </tr>
                      {historyId === m.id && (
                        <tr key={`vh-${m.id}`}>
                          <td colSpan={10} style={{ padding: '12px 24px', background: 'var(--color-surface-2)' }}>
                            {(() => {
                              const d = historyData[m.id];
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
                                        <Line type="monotone" dataKey="value" name="Value" stroke="#f5a623" strokeWidth={2} dot />
                                      </LineChart>
                                    </ResponsiveContainer>
                                  ) : d.hist.length === 1 ? (
                                    <p style={{ color: 'var(--color-text-muted)' }}>Only one data point. Refresh prices or update manually to see a trend.</p>
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

          <div style={{ marginTop: 8, fontSize: 12, color: 'var(--color-text-muted)', padding: '0 4px' }}>
            ℹ️ Spot prices from api.metalpriceapi.com (in {currency}/gram). Values are calculated as: qty × purity × price/g.
          </div>
        </div>
      )}

      {showModal && (
        <div className="modal-backdrop" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
            <h3>{editing ? 'Edit Metal Holding' : 'Add Metal Holding'}</h3>
            {error && <div className="error-msg">{error}</div>}

            <div className="form-row">
              <div className="form-group">
                <label>Name *</label>
                <input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="24K Gold Coin, Silver Bar…"
                />
              </div>
              <div className="form-group">
                <label>Metal Type</label>
                <select value={form.metal_type} onChange={(e) => setForm({ ...form, metal_type: e.target.value, purity: '' })}>
                  {METAL_TYPES.map((t) => (
                    <option key={t} value={t}>{METAL_ICONS[t]} {typeLabel(t)}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label>Form</label>
                <select value={form.metal_form} onChange={(e) => setForm({ ...form, metal_form: e.target.value })}>
                  {METAL_FORMS.map((f) => (
                    <option key={f} value={f}>{typeLabel(f)}</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>Purity</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    value={form.purity}
                    onChange={(e) => setForm({ ...form, purity: e.target.value })}
                    placeholder="e.g. 24k, 999, 925"
                    style={{ flex: 1 }}
                  />
                  <select
                    value=""
                    onChange={(e) => { if (e.target.value) setForm({ ...form, purity: e.target.value }); }}
                    style={{ width: 80 }}
                    title="Select a common purity"
                  >
                    <option value="">preset</option>
                    {(PURITY_PRESETS[form.metal_type] || []).map((p) => (
                      <option key={p} value={p}>{p}</option>
                    ))}
                  </select>
                </div>
                <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 2 }}>
                  Formats: 24k, 18k, 999.9, 925, 99.9% — leave blank for pure
                </div>
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label>Quantity (grams) *</label>
                <input
                  type="number"
                  min="0"
                  step="0.001"
                  value={form.quantity_grams}
                  onChange={(e) => setForm({ ...form, quantity_grams: e.target.value })}
                  placeholder="10"
                />
              </div>
              <div className="form-group">
                <label>Current Price / gram{currency ? ` (${currency})` : ''}</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.current_price_gram}
                  onChange={(e) => setForm({ ...form, current_price_gram: e.target.value })}
                  placeholder="Use Refresh Prices or enter manually"
                />
              </div>
            </div>

            {/* Live value preview */}
            {form.quantity_grams && form.current_price_gram && (
              <div style={{
                background: 'var(--color-surface-2)',
                borderRadius: 6,
                padding: '8px 12px',
                marginBottom: 12,
                fontSize: 13,
              }}>
                💡 Estimated value:{' '}
                <strong>
                  {fmt(
                    Number(form.quantity_grams) *
                    (form.purity
                      ? (() => {
                          const s = form.purity.trim().toLowerCase();
                          const km = s.match(/^(\d+(\.\d+)?)k$/);
                          if (km) return Math.min(parseFloat(km[1]) / 24, 1.0);
                          const pm = s.match(/^(\d+(\.\d+)?)%$/);
                          if (pm) return Math.min(parseFloat(pm[1]) / 100, 1.0);
                          const n = parseFloat(s);
                          if (!isNaN(n)) return n > 1 ? Math.min(n / 1000, 1.0) : Math.min(n, 1.0);
                          return 1.0;
                        })()
                      : 1.0) *
                    Number(form.current_price_gram)
                  )}
                </strong>
                {form.purity && (
                  <span style={{ color: 'var(--color-text-muted)', marginLeft: 8 }}>
                    (purity applied)
                  </span>
                )}
              </div>
            )}

            <div className="form-row">
              <div className="form-group">
                <label>Acquisition Date</label>
                <input
                  type="date"
                  value={form.acquisition_date}
                  onChange={(e) => setForm({ ...form, acquisition_date: e.target.value })}
                />
              </div>
              <div className="form-group">
                <label>Cost Basis{currency ? ` (${currency})` : ''}</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.acquisition_cost}
                  onChange={(e) => setForm({ ...form, acquisition_cost: e.target.value })}
                  placeholder="Total purchase cost"
                />
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
