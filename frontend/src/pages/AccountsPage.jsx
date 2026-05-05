import { Fragment, useEffect, useRef, useState } from 'react';
import { api } from '../hooks/apiAdapter';
import { formatCurrency, formatDate, typeLabel } from '../hooks/format';
import { useCurrency } from '../hooks/CurrencyContext';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

const ACCOUNT_TYPES = ['checking', 'savings', 'money_market', 'cd', 'brokerage', '401k', 'ira', 'roth_ira', 'pension', 'other'];

// Account types that can hold investment positions (stocks, mutual funds, etc.)
// Includes global equivalents: money_market (money market funds), brokerage/demat accounts,
// retirement plans (401k/IRA for US; pension/other for non-US regions like PPF, NPS, TFSA, RRSP).
// Pure deposit types (checking, savings, cd/FD) are excluded.
const INVESTMENT_ACCOUNT_TYPES = new Set(['money_market', 'brokerage', '401k', 'ira', 'roth_ira', 'pension', 'other']);

const EMPTY_HOLDING = { symbol: '', name: '', shares: '', current_price: '', current_value: '' };

// ─── Kebab action menu ────────────────────────────────────────────────────────
// Uses position:fixed so it escapes table overflow clipping.
function ActionMenu({ isInvestment, onEdit, onDelete, onAddHolding, onHistory }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, right: 0 });
  const btnRef = useRef(null);
  const menuRef = useRef(null);

  function toggle() {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
    }
    setOpen((o) => !o);
  }

  useEffect(() => {
    if (!open) return;
    function handle(e) {
      if (!menuRef.current?.contains(e.target) && !btnRef.current?.contains(e.target)) setOpen(false);
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', handle);
    document.addEventListener('keydown', handle);
    return () => { document.removeEventListener('mousedown', handle); document.removeEventListener('keydown', handle); };
  }, [open]);

  return (
    <div style={{ display: 'inline-block' }}>
      <button ref={btnRef} className="btn-ghost btn-sm action-menu-btn" onClick={toggle} title="Actions">⋮</button>
      {open && (
        <ul ref={menuRef} className="action-menu" style={{ top: pos.top, right: pos.right }}>
          <li><button onClick={() => { onEdit(); setOpen(false); }}>✏️ Edit</button></li>
          {isInvestment && <li><button onClick={() => { onAddHolding(); setOpen(false); }}>📊 Add Holding</button></li>}
          <li><button onClick={() => { onHistory(); setOpen(false); }}>📈 History</button></li>
          <li><button className="danger" onClick={() => { onDelete(); setOpen(false); }}>🗑️ Delete</button></li>
        </ul>
      )}
    </div>
  );
}

export default function AccountsPage() {
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(() => ({ name: '', institution: '', type: 'checking', currency: '', balance: '', notes: '' }));
  const [expandedId, setExpandedId] = useState(null);
  const [holdings, setHoldings] = useState({});
  const [showHoldingModal, setShowHoldingModal] = useState(false);
  const [holdingForm, setHoldingForm] = useState(EMPTY_HOLDING);
  const [holdingAccountId, setHoldingAccountId] = useState(null);
  const [historyId, setHistoryId] = useState(null);
  const [historyData, setHistoryData] = useState({});
  const [filterText, setFilterText] = useState('');
  const [filterType, setFilterType] = useState('');
  const [sortKey, setSortKey] = useState('name');
  const [sortDir, setSortDir] = useState('asc');
  // Set of type keys whose group rows are collapsed; empty = all expanded
  const [collapsedGroups, setCollapsedGroups] = useState(new Set());
  const { currency } = useCurrency();
  const fmt = (v) => formatCurrency(v, currency);

  function toggleSort(key) {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('asc'); }
  }

  function SortIcon({ col }) {
    if (sortKey !== col) return <span style={{ opacity: 0.3, marginLeft: 4 }}>↕</span>;
    return <span style={{ marginLeft: 4 }}>{sortDir === 'asc' ? '↑' : '↓'}</span>;
  }

  function toggleGroup(type) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type); else next.add(type);
      return next;
    });
  }

  // Accounts after search / type filter, sorted by chosen column
  const visibleAccounts = accounts
    .filter((a) => {
      const q = filterText.toLowerCase();
      const matchText = !q || a.name.toLowerCase().includes(q) || (a.institution || '').toLowerCase().includes(q);
      const matchType = !filterType || a.type === filterType;
      return matchText && matchType;
    })
    .sort((a, b) => {
      let av = a[sortKey] ?? '';
      let bv = b[sortKey] ?? '';
      if (sortKey === 'balance') { av = Number(av); bv = Number(bv); }
      else { av = String(av).toLowerCase(); bv = String(bv).toLowerCase(); }
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });

  // Group visible accounts by type, groups sorted by total balance descending
  const groupedAccounts = (() => {
    const map = {};
    for (const acc of visibleAccounts) {
      if (!map[acc.type]) map[acc.type] = [];
      map[acc.type].push(acc);
    }
    return Object.entries(map)
      .map(([type, accs]) => ({ type, accounts: accs, total: accs.reduce((s, a) => s + Number(a.balance || 0), 0) }))
      .sort((a, b) => b.total - a.total);
  })();

  // Per-type count across all accounts (not just filtered) for the chip strip
  const typeCounts = accounts.reduce((m, a) => { m[a.type] = (m[a.type] || 0) + 1; return m; }, {});

  const makeEmpty = () => ({ name: '', institution: '', type: 'checking', currency, balance: '', notes: '' });

  const load = () => api.getAccounts().then(setAccounts).catch(e => setError(e.message)).finally(() => setLoading(false));

  useEffect(() => { load(); }, []);

  function openCreate() { setEditing(null); setForm(makeEmpty()); setShowModal(true); }
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

  async function toggleHistory(id) {
    if (historyId === id) { setHistoryId(null); return; }
    setHistoryId(id);
    if (!historyData[id]) {
      const [hist, growth] = await Promise.all([
        api.getValueHistory('account', id).catch(() => []),
        api.getValueGrowth('account', id).catch(() => null),
      ]);
      setHistoryData((prev) => ({ ...prev, [id]: { hist, growth } }));
    }
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
          {/* ── Type-chip summary strip ── */}
          <div className="type-chips">
            {ACCOUNT_TYPES.filter((t) => typeCounts[t]).map((t) => (
              <button
                key={t}
                className={`type-chip${filterType === t ? ' active' : ''}`}
                onClick={() => setFilterType(filterType === t ? '' : t)}
              >
                <span className={`badge badge-${t}`}>{typeLabel(t)}</span>
                <span className="chip-count">{typeCounts[t]}</span>
              </button>
            ))}
          </div>

          {/* ── Search / filter bar ── */}
          <div className="flex-gap" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
            <input
              placeholder="Search name or institution…"
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              style={{ flex: '1 1 180px', padding: '6px 10px', borderRadius: 6, border: '1px solid var(--color-border)', background: 'var(--color-surface)', color: 'var(--color-text)', fontSize: 14 }}
            />
            <select
              value={filterType}
              onChange={(e) => setFilterType(e.target.value)}
              style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid var(--color-border)', background: 'var(--color-surface)', color: 'var(--color-text)', fontSize: 14 }}
            >
              <option value="">All types</option>
              {ACCOUNT_TYPES.map((t) => <option key={t} value={t}>{typeLabel(t)}</option>)}
            </select>
            {(filterText || filterType) && (
              <button className="btn-ghost btn-sm" onClick={() => { setFilterText(''); setFilterType(''); }}>✕ Clear</button>
            )}
            <span style={{ marginLeft: 'auto', fontSize: 13, color: 'var(--color-text-muted)' }}>
              {visibleAccounts.length} of {accounts.length}
            </span>
          </div>

          {/* ── Grouped accounts table ── */}
          <div className="table-container accounts-table-container">
            <table className="accounts-table">
              <thead>
                <tr>
                  <th style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => toggleSort('name')}>Name<SortIcon col="name" /></th>
                  <th className="hide-mobile" style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => toggleSort('institution')}>Institution<SortIcon col="institution" /></th>
                  <th className="hide-mobile">Currency</th>
                  <th style={{ textAlign: 'right', cursor: 'pointer', userSelect: 'none' }} onClick={() => toggleSort('balance')}>Balance<SortIcon col="balance" /></th>
                  <th style={{ width: 40 }}></th>
                </tr>
              </thead>
              <tbody>
                {visibleAccounts.length === 0 ? (
                  <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--color-text-muted)', padding: 24 }}>No accounts match the current filters.</td></tr>
                ) : groupedAccounts.map(({ type, accounts: groupAccs, total }) => (
                  <Fragment key={type}>
                    {/* Group header row – click to collapse/expand */}
                    <tr className="group-header-row" onClick={() => toggleGroup(type)}>
                      <td colSpan={5}>
                        <div className="group-header-inner">
                          <span className="group-chevron">{collapsedGroups.has(type) ? '▶' : '▼'}</span>
                          <span className={`badge badge-${type}`}>{typeLabel(type)}</span>
                          <span className="group-count">{groupAccs.length} account{groupAccs.length !== 1 ? 's' : ''}</span>
                          <span className="group-total">{fmt(total)}</span>
                        </div>
                      </td>
                    </tr>

                    {/* Account rows – hidden when group is collapsed */}
                    {!collapsedGroups.has(type) && groupAccs.map((acc) => (
                      <Fragment key={acc.id}>
                        <tr className="account-row">
                          <td className="td-name">
                            {INVESTMENT_ACCOUNT_TYPES.has(acc.type) && (
                              <button
                                className="btn-ghost btn-sm"
                                onClick={(e) => { e.stopPropagation(); toggleHoldings(acc.id); }}
                                aria-label={expandedId === acc.id ? 'Collapse holdings' : 'Expand holdings'}
                                style={{ marginRight: 6 }}
                              >
                                {expandedId === acc.id ? '▾' : '▸'}
                              </button>
                            )}
                            <strong>{acc.name}</strong>
                            {acc.institution && <span className="show-mobile-only account-institution"><span className="institution-sep"> · </span>{acc.institution}</span>}
                          </td>
                          <td className="hide-mobile">{acc.institution || '—'}</td>
                          <td className="hide-mobile">{acc.currency}</td>
                          <td className="td-balance amount" style={{ textAlign: 'right' }}>{fmt(acc.balance)}</td>
                          <td className="td-actions">
                            <ActionMenu
                              isInvestment={INVESTMENT_ACCOUNT_TYPES.has(acc.type)}
                              onEdit={() => openEdit(acc)}
                              onDelete={() => remove(acc.id)}
                              onAddHolding={() => { setHoldingAccountId(acc.id); setHoldingForm(EMPTY_HOLDING); setShowHoldingModal(true); }}
                              onHistory={() => toggleHistory(acc.id)}
                            />
                          </td>
                        </tr>

                        {/* Holdings expanded row */}
                        {INVESTMENT_ACCOUNT_TYPES.has(acc.type) && expandedId === acc.id && (
                          <tr className="expand-row">
                            <td colSpan={5} style={{ padding: '0 24px 12px', background: 'var(--color-surface-2)' }}>
                              {holdings[acc.id]?.length > 0 ? (
                                <table style={{ marginTop: 8 }}>
                                  <thead><tr><th>Symbol</th><th>Name</th><th>Shares</th><th style={{ textAlign: 'right' }}>Price</th><th style={{ textAlign: 'right' }}>Value</th></tr></thead>
                                  <tbody>
                                    {holdings[acc.id].map((h) => (
                                      <tr key={h.id}>
                                        <td><strong>{h.symbol}</strong></td>
                                        <td>{h.name || '—'}</td>
                                        <td>{h.shares}</td>
                                        <td style={{ textAlign: 'right' }}>{h.current_price ? fmt(h.current_price) : '—'}</td>
                                        <td style={{ textAlign: 'right' }} className="amount positive">{fmt(h.current_value || h.shares * (h.current_price || 0))}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              ) : <p style={{ padding: '8px 0', color: 'var(--color-text-muted)' }}>No holdings. Use the ⋮ menu → "Add Holding" to add investment positions.</p>}
                            </td>
                          </tr>
                        )}

                        {/* History expanded row */}
                        {historyId === acc.id && (
                          <tr className="expand-row">
                            <td colSpan={5} style={{ padding: '12px 24px', background: 'var(--color-surface-2)' }}>
                              {(() => {
                                const d = historyData[acc.id];
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
                                        <span>Data points: <strong>{g.data_points}</strong></span>
                                      </div>
                                    )}
                                    {d.hist.length > 1 ? (
                                      <ResponsiveContainer width="100%" height={180}>
                                        <LineChart data={d.hist} margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
                                          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                                          <XAxis dataKey="recorded_at" tick={{ fontSize: 10 }} />
                                          <YAxis tickFormatter={(v) => fmt(v)} tick={{ fontSize: 10 }} />
                                          <Tooltip formatter={(v) => fmt(v)} />
                                          <Line type="monotone" dataKey="value" name="Balance" stroke="#0366d6" strokeWidth={2} dot />
                                        </LineChart>
                                      </ResponsiveContainer>
                                    ) : d.hist.length === 1 ? (
                                      <p style={{ color: 'var(--color-text-muted)' }}>Only one data point recorded. Update the balance to see a trend.</p>
                                    ) : (
                                      <p style={{ color: 'var(--color-text-muted)' }}>No history recorded yet.</p>
                                    )}
                                  </>
                                );
                              })()}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </Fragment>
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
                <input value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })} placeholder={currency || 'e.g. USD, EUR, INR'} />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Current Balance{form.currency ? ` (${form.currency})` : ''}</label>
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
                <label>Current Price{currency ? ` (${currency})` : ''}</label>
                <input type="number" value={holdingForm.current_price} onChange={(e) => setHoldingForm({ ...holdingForm, current_price: e.target.value })} placeholder="180.00" />
              </div>
              <div className="form-group">
                <label>Current Value{currency ? ` (${currency})` : ''}</label>
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
