import { useEffect, useState } from 'react';
import { api } from '../hooks/api';
import { formatCurrency, formatDate, formatPct } from '../hooks/format';
import { useCurrency } from '../hooks/CurrencyContext';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend,
} from 'recharts';

const EMPTY_FORM = {
  name: '', symbol: '', account_id: '', amount: '', units: '', nav: '',
  installment_date: new Date().toISOString().slice(0, 10), notes: '',
};

export default function SipPage() {
  const [installments, setInstallments] = useState([]);
  const [summary, setSummary] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [filterSymbol, setFilterSymbol] = useState('');
  const [activeTab, setActiveTab] = useState('installments');
  const { currency } = useCurrency();
  const fmt = (v) => formatCurrency(v, currency);

  const load = async () => {
    try {
      const [inst, summ, accs] = await Promise.all([
        api.getSipInstallments(filterSymbol ? { symbol: filterSymbol } : {}),
        api.getSipSummary(),
        api.getAccounts(),
      ]);
      setInstallments(inst);
      setSummary(summ);
      setAccounts(accs);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [filterSymbol]);

  function openCreate() {
    setEditing(null);
    setForm({ ...EMPTY_FORM, installment_date: new Date().toISOString().slice(0, 10) });
    setError('');
    setShowModal(true);
  }

  function openEdit(inst) {
    setEditing(inst);
    setForm({
      name: inst.name,
      symbol: inst.symbol || '',
      account_id: inst.account_id || '',
      amount: inst.amount,
      units: inst.units ?? '',
      nav: inst.nav ?? '',
      installment_date: inst.installment_date,
      notes: inst.notes || '',
    });
    setError('');
    setShowModal(true);
  }

  async function save() {
    try {
      setError('');
      const payload = {
        name: form.name,
        symbol: form.symbol || null,
        account_id: form.account_id ? Number(form.account_id) : null,
        amount: Number(form.amount),
        units: form.units !== '' ? Number(form.units) : null,
        nav: form.nav !== '' ? Number(form.nav) : null,
        installment_date: form.installment_date,
        notes: form.notes || null,
      };
      if (editing) await api.updateSipInstallment(editing.id, payload);
      else await api.createSipInstallment(payload);
      setShowModal(false);
      load();
    } catch (e) {
      setError(e.message);
    }
  }

  async function remove(id) {
    if (!confirm('Delete this SIP installment?')) return;
    try { await api.deleteSipInstallment(id); load(); }
    catch (e) { setError(e.message); }
  }

  const totalInvested = installments.reduce((s, i) => s + i.amount, 0);
  const symbols = [...new Set(installments.map((i) => i.symbol).filter(Boolean))];

  // Chart data: cumulative investment over time for filtered view
  const chartData = [...installments]
    .sort((a, b) => a.installment_date.localeCompare(b.installment_date))
    .reduce((acc, inst) => {
      const prev = acc.length > 0 ? acc[acc.length - 1] : null;
      const cumulative = (prev ? prev.cumulative : 0) + inst.amount;
      acc.push({ date: inst.installment_date, amount: inst.amount, cumulative });
      return acc;
    }, []);

  if (loading) return <div className="loading-center"><div className="spinner" /></div>;

  return (
    <div>
      <div className="page-header">
        <h2>SIP Tracker <span style={{ fontSize: 14, fontWeight: 400, color: 'var(--color-text-muted)' }}>Total Invested: <strong>{fmt(totalInvested)}</strong></span></h2>
        <button className="btn-primary" onClick={openCreate}>+ Add Installment</button>
      </div>

      {error && <div className="error-msg">{error}</div>}

      {/* Tab switcher */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {['installments', 'summary', 'chart'].map((tab) => (
          <button
            key={tab}
            className={activeTab === tab ? 'btn-primary' : 'btn-ghost'}
            onClick={() => setActiveTab(tab)}
            style={{ textTransform: 'capitalize' }}
          >
            {tab === 'installments' ? '📋 Installments' : tab === 'summary' ? '📊 Summary' : '📈 Trend'}
          </button>
        ))}
      </div>

      {/* Installments tab */}
      {activeTab === 'installments' && (
        <>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
            <label style={{ fontWeight: 600, fontSize: 13 }}>Filter by Symbol:</label>
            <select value={filterSymbol} onChange={(e) => setFilterSymbol(e.target.value)} style={{ maxWidth: 180 }}>
              <option value="">All</option>
              {symbols.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          {installments.length === 0 ? (
            <div className="card empty-state">
              <div className="icon">💰</div>
              <p>No SIP installments yet. Start tracking your systematic investments.</p>
            </div>
          ) : (
            <div className="card">
              <div className="table-container">
                <table>
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Name</th>
                      <th>Symbol</th>
                      <th>Account</th>
                      <th style={{ textAlign: 'right' }}>Amount</th>
                      <th style={{ textAlign: 'right' }}>Units</th>
                      <th style={{ textAlign: 'right' }}>NAV</th>
                      <th>Notes</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {installments.map((inst) => (
                      <tr key={inst.id}>
                        <td>{formatDate(inst.installment_date)}</td>
                        <td><strong>{inst.name}</strong></td>
                        <td>{inst.symbol ? <span className="badge">{inst.symbol}</span> : '—'}</td>
                        <td>{inst.account_name || '—'}</td>
                        <td style={{ textAlign: 'right' }} className="amount positive">{fmt(inst.amount)}</td>
                        <td style={{ textAlign: 'right' }}>{inst.units != null ? inst.units.toFixed(4) : '—'}</td>
                        <td style={{ textAlign: 'right' }}>{inst.nav != null ? fmt(inst.nav) : '—'}</td>
                        <td style={{ color: 'var(--color-text-muted)', fontSize: 12 }}>{inst.notes || '—'}</td>
                        <td>
                          <div className="flex-gap">
                            <button className="btn-ghost btn-sm" onClick={() => openEdit(inst)}>Edit</button>
                            <button className="btn-danger btn-sm" onClick={() => remove(inst.id)}>Delete</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {/* Summary tab */}
      {activeTab === 'summary' && (
        summary.length === 0 ? (
          <div className="card empty-state">
            <div className="icon">📊</div>
            <p>No SIP data yet to summarize.</p>
          </div>
        ) : (
          <div className="card">
            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th style={{ textAlign: 'right' }}>Installments</th>
                    <th style={{ textAlign: 'right' }}>Total Invested</th>
                    <th style={{ textAlign: 'right' }}>Total Units</th>
                    <th style={{ textAlign: 'right' }}>Avg NAV</th>
                    <th>First SIP</th>
                    <th>Last SIP</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.map((row, i) => (
                    <tr key={i}>
                      <td><strong>{row.symbol || '—'}</strong></td>
                      <td style={{ textAlign: 'right' }}>{row.installment_count}</td>
                      <td style={{ textAlign: 'right' }} className="amount positive">{fmt(row.total_invested)}</td>
                      <td style={{ textAlign: 'right' }}>{row.total_units != null ? row.total_units.toFixed(4) : '—'}</td>
                      <td style={{ textAlign: 'right' }}>{row.average_nav != null ? fmt(row.average_nav) : '—'}</td>
                      <td>{formatDate(row.first_installment_date)}</td>
                      <td>{formatDate(row.last_installment_date)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      )}

      {/* Trend chart tab */}
      {activeTab === 'chart' && (
        chartData.length < 2 ? (
          <div className="card empty-state">
            <div className="icon">📈</div>
            <p>Add at least 2 SIP installments to see the trend chart.</p>
          </div>
        ) : (
          <div className="card">
            <div className="section-title">Cumulative SIP Investment Over Time</div>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={chartData} margin={{ top: 5, right: 20, bottom: 5, left: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                <YAxis tickFormatter={(v) => fmt(v)} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v) => fmt(v)} />
                <Legend />
                <Line type="monotone" dataKey="cumulative" name="Cumulative Invested" stroke="#0366d6" strokeWidth={2.5} dot={false} />
                <Line type="monotone" dataKey="amount" name="Per Installment" stroke="#28a745" strokeWidth={1.5} dot />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )
      )}

      {/* Modal */}
      {showModal && (
        <div className="modal-backdrop" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{editing ? 'Edit SIP Installment' : 'Add SIP Installment'}</h3>
            {error && <div className="error-msg">{error}</div>}
            <div className="form-row">
              <div className="form-group">
                <label>SIP Name *</label>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="NIFTY 50 SIP" />
              </div>
              <div className="form-group">
                <label>Symbol / Fund Code</label>
                <input value={form.symbol} onChange={(e) => setForm({ ...form, symbol: e.target.value.toUpperCase() })} placeholder="NIFTYBEES" />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Amount *</label>
                <input type="number" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="5000" />
              </div>
              <div className="form-group">
                <label>Units / Shares</label>
                <input type="number" value={form.units} onChange={(e) => setForm({ ...form, units: e.target.value })} placeholder="10.5" />
              </div>
              <div className="form-group">
                <label>NAV / Price</label>
                <input type="number" value={form.nav} onChange={(e) => setForm({ ...form, nav: e.target.value })} placeholder="476.19" />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Installment Date</label>
                <input type="date" value={form.installment_date} onChange={(e) => setForm({ ...form, installment_date: e.target.value })} />
              </div>
              <div className="form-group">
                <label>Linked Account</label>
                <select value={form.account_id} onChange={(e) => setForm({ ...form, account_id: e.target.value })}>
                  <option value="">None</option>
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
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
