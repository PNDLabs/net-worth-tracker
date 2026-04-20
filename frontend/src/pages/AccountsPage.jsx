import { useEffect, useState } from 'react';
import { api } from '../hooks/api';
import { formatCurrency, typeLabel } from '../hooks/format';

const ACCOUNT_TYPES = ['checking', 'savings', 'money_market', 'cd', 'brokerage', '401k', 'ira', 'roth_ira', 'pension', 'other'];

const EMPTY = { name: '', institution: '', type: 'checking', currency: 'USD', balance: '', notes: '' };
const EMPTY_HOLDING = { symbol: '', name: '', shares: '', current_price: '', current_value: '' };

export default function AccountsPage() {
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [expandedId, setExpandedId] = useState(null);
  const [holdings, setHoldings] = useState({});
  const [showHoldingModal, setShowHoldingModal] = useState(false);
  const [holdingForm, setHoldingForm] = useState(EMPTY_HOLDING);
  const [holdingAccountId, setHoldingAccountId] = useState(null);

  const load = () => api.getAccounts().then(setAccounts).catch(e => setError(e.message)).finally(() => setLoading(false));

  useEffect(() => { load(); }, []);

  function openCreate() { setEditing(null); setForm(EMPTY); setShowModal(true); }
  function openEdit(acc) { setEditing(acc); setForm({ ...acc, balance: acc.balance, notes: acc.notes || '' }); setShowModal(true); }

  async function save() {
    try {
      setError('');
      const payload = { ...form, balance: Number(form.balance) };
      if (editing) await api.updateAccount(editing.id, payload);
      else await api.createAccount(payload);
      setShowModal(false);
      load();
    } catch (e) { setError(e.message); }
  }

  async function remove(id) {
    if (!confirm('Delete this account?')) return;
    try { await api.deleteAccount(id); load(); }
    catch (e) { setError(e.message); }
  }

  async function toggleHoldings(id) {
    if (expandedId === id) { setExpandedId(null); return; }
    setExpandedId(id);
    if (!holdings[id]) {
      const h = await api.getHoldings(id).catch(() => []);
      setHoldings((prev) => ({ ...prev, [id]: h }));
    }
  }

  async function saveHolding() {
    try {
      const payload = { ...holdingForm, shares: Number(holdingForm.shares), current_price: holdingForm.current_price ? Number(holdingForm.current_price) : null, current_value: holdingForm.current_value ? Number(holdingForm.current_value) : null };
      await api.createHolding(holdingAccountId, payload);
      const h = await api.getHoldings(holdingAccountId);
      setHoldings((prev) => ({ ...prev, [holdingAccountId]: h }));
      setShowHoldingModal(false);
    } catch (e) { setError(e.message); }
  }

  if (loading) return <div className="loading-center"><div className="spinner" /></div>;

  return (
    <div>
      <div className="page-header">
        <h2>Accounts</h2>
        <button className="btn-primary" onClick={openCreate}>+ Add Account</button>
      </div>

      {error && <div className="error-msg">{error}</div>}

      {accounts.length === 0 ? (
        <div className="card empty-state">
          <div className="icon">🏦</div>
          <p>No accounts yet. Add your first bank or investment account.</p>
        </div>
      ) : (
        <div className="card">
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>Name</th><th>Institution</th><th>Type</th><th>Currency</th>
                  <th style={{ textAlign: 'right' }}>Balance</th><th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((acc) => (
                  <>
                    <tr key={acc.id}>
                      <td>
                        <button className="btn-ghost btn-sm" onClick={() => toggleHoldings(acc.id)} style={{ marginRight: 6 }}>
                          {expandedId === acc.id ? '▾' : '▸'}
                        </button>
                        <strong>{acc.name}</strong>
                      </td>
                      <td>{acc.institution || '—'}</td>
                      <td><span className={`badge badge-${acc.type}`}>{typeLabel(acc.type)}</span></td>
                      <td>{acc.currency}</td>
                      <td className="amount" style={{ textAlign: 'right' }}>{formatCurrency(acc.balance, acc.currency)}</td>
                      <td>
                        <div className="flex-gap">
                          <button className="btn-ghost btn-sm" onClick={() => openEdit(acc)}>Edit</button>
                          <button className="btn-danger btn-sm" onClick={() => remove(acc.id)}>Delete</button>
                          <button className="btn-ghost btn-sm" onClick={() => { setHoldingAccountId(acc.id); setHoldingForm(EMPTY_HOLDING); setShowHoldingModal(true); }}>+ Holding</button>
                        </div>
                      </td>
                    </tr>
                    {expandedId === acc.id && (
                      <tr key={`h-${acc.id}`}>
                        <td colSpan={6} style={{ padding: '0 24px 12px', background: 'var(--color-surface-2)' }}>
                          {holdings[acc.id]?.length > 0 ? (
                            <table style={{ marginTop: 8 }}>
                              <thead><tr><th>Symbol</th><th>Name</th><th>Shares</th><th style={{ textAlign: 'right' }}>Price</th><th style={{ textAlign: 'right' }}>Value</th></tr></thead>
                              <tbody>
                                {holdings[acc.id].map((h) => (
                                  <tr key={h.id}>
                                    <td><strong>{h.symbol}</strong></td>
                                    <td>{h.name || '—'}</td>
                                    <td>{h.shares}</td>
                                    <td style={{ textAlign: 'right' }}>{h.current_price ? formatCurrency(h.current_price) : '—'}</td>
                                    <td style={{ textAlign: 'right' }} className="amount positive">{formatCurrency(h.current_value || h.shares * (h.current_price || 0))}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          ) : <p style={{ padding: '8px 0', color: 'var(--color-text-muted)' }}>No holdings. Click "+ Holding" to add investment positions.</p>}
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Account modal */}
      {showModal && (
        <div className="modal-backdrop" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{editing ? 'Edit Account' : 'Add Account'}</h3>
            {error && <div className="error-msg">{error}</div>}
            <div className="form-row">
              <div className="form-group">
                <label>Name *</label>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Chase Checking" />
              </div>
              <div className="form-group">
                <label>Institution</label>
                <input value={form.institution} onChange={(e) => setForm({ ...form, institution: e.target.value })} placeholder="Chase Bank" />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Type</label>
                <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                  {ACCOUNT_TYPES.map((t) => <option key={t} value={t}>{typeLabel(t)}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label>Currency</label>
                <input value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })} placeholder="USD" />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Current Balance ($)</label>
                <input type="number" value={form.balance} onChange={(e) => setForm({ ...form, balance: e.target.value })} placeholder="0" />
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

      {/* Holding modal */}
      {showHoldingModal && (
        <div className="modal-backdrop" onClick={() => setShowHoldingModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Add Holding</h3>
            <div className="form-row">
              <div className="form-group">
                <label>Ticker Symbol *</label>
                <input value={holdingForm.symbol} onChange={(e) => setHoldingForm({ ...holdingForm, symbol: e.target.value.toUpperCase() })} placeholder="AAPL" />
              </div>
              <div className="form-group">
                <label>Name</label>
                <input value={holdingForm.name} onChange={(e) => setHoldingForm({ ...holdingForm, name: e.target.value })} placeholder="Apple Inc." />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Shares</label>
                <input type="number" value={holdingForm.shares} onChange={(e) => setHoldingForm({ ...holdingForm, shares: e.target.value })} placeholder="10" />
              </div>
              <div className="form-group">
                <label>Current Price ($)</label>
                <input type="number" value={holdingForm.current_price} onChange={(e) => setHoldingForm({ ...holdingForm, current_price: e.target.value })} placeholder="180.00" />
              </div>
              <div className="form-group">
                <label>Current Value ($)</label>
                <input type="number" value={holdingForm.current_value} onChange={(e) => setHoldingForm({ ...holdingForm, current_value: e.target.value })} placeholder="1800" />
              </div>
            </div>
            <div className="modal-actions">
              <button className="btn-ghost" onClick={() => setShowHoldingModal(false)}>Cancel</button>
              <button className="btn-primary" onClick={saveHolding}>Add Holding</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
