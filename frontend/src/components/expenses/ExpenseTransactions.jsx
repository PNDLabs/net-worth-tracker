import { useEffect, useState } from 'react';
import { api } from '../../hooks/apiAdapter';
import { formatCurrency, formatDate } from '../../hooks/format';
import { useCurrency } from '../../hooks/CurrencyContext';
import { KIND_OPTIONS, KIND_LABELS, EXCLUDED_KINDS, currentMonth, formatMonth } from './constants';

const DEFAULT_FILTER = { month: '', kind: '', category: '', member: '', needs_review: '' };

export default function ExpenseTransactions({ initialFilter }) {
  const [filter, setFilter] = useState(() => ({ ...DEFAULT_FILTER, month: currentMonth(), ...initialFilter }));
  const [rows, setRows] = useState(null);
  const [categories, setCategories] = useState([]);
  const [statements, setStatements] = useState([]);
  const [rules, setRules] = useState([]);
  const [members, setMembers] = useState([]);
  const [remember, setRemember] = useState(true);
  const [showRules, setShowRules] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [error, setError] = useState('');
  const { currency } = useCurrency();
  const fmt = (v) => formatCurrency(v, currency);

  useEffect(() => {
    api.getNetWorth().then((nw) => setMembers((nw.members || []).map((m) => m.name))).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.getExpenseTransactions(filter),
      api.getExpenseCategories(),
      api.getExpenseStatements(),
      api.getMerchantRules(),
    ])
      .then(([txns, cats, stmts, rls]) => {
        if (cancelled) return;
        setRows(txns);
        setCategories(cats);
        setStatements(stmts);
        setRules(rls);
        setError('');
      })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [filter, reloadKey]);

  const reload = () => setReloadKey((k) => k + 1);
  const updateFilter = (patch) => setFilter((f) => ({ ...f, ...patch }));

  async function edit(row, patch) {
    try {
      await api.updateExpenseTransaction(row.id, { ...patch, remember });
      reload();
    } catch (e) {
      setError(e.message);
    }
  }

  async function removeStatement(statement) {
    if (!window.confirm(`Delete this statement and its ${statement.transaction_count} transactions?`)) return;
    try {
      await api.deleteExpenseStatement(statement.id);
      reload();
    } catch (e) {
      setError(e.message);
    }
  }

  async function removeRule(rule) {
    try {
      await api.deleteMerchantRule(rule.id);
      reload();
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <div>
      {error && <div className="error-msg">{error}</div>}

      <div className="filter-row">
        <div className="form-group">
          <label>Month</label>
          <input type="month" value={filter.month} onChange={(e) => updateFilter({ month: e.target.value })} />
        </div>
        <div className="form-group">
          <label>Kind</label>
          <select value={filter.kind} onChange={(e) => updateFilter({ kind: e.target.value })}>
            <option value="">All kinds</option>
            {KIND_OPTIONS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label>Category</label>
          <select value={filter.category} onChange={(e) => updateFilter({ category: e.target.value })}>
            <option value="">All categories</option>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label>Family member</label>
          <select value={filter.member} onChange={(e) => updateFilter({ member: e.target.value })}>
            <option value="">All members</option>
            {members.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
        <label className="flex-gap">
          <input
            type="checkbox"
            checked={filter.needs_review === '1'}
            onChange={(e) => updateFilter({ needs_review: e.target.checked ? '1' : '' })}
          />
          Needs review only
        </label>
        <label className="flex-gap">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Remember my changes for each merchant
        </label>
      </div>

      <div className="section-title">{filter.month ? formatMonth(filter.month) : 'All months'}</div>
      {rows === null ? (
        <div className="loading-center"><div className="spinner" /></div>
      ) : rows.length === 0 ? (
        <div className="card empty-state"><p>No transactions match these filters.</p></div>
      ) : (
        <div className="card">
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Description</th>
                  <th className="hide-mobile">Account</th>
                  <th style={{ textAlign: 'right' }}>Amount</th>
                  <th>Kind</th>
                  <th>Category</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const excluded = EXCLUDED_KINDS.includes(r.kind);
                  const options = r.category && !categories.includes(r.category) ? [...categories, r.category] : categories;
                  return (
                    <tr key={r.id} className={r.needs_review ? 'row-review' : ''}>
                      <td>{formatDate(r.txn_date)}</td>
                      <td>
                        <div>{r.merchant || r.description}</div>
                        {r.merchant && <div className="muted-note" style={{ fontSize: 11 }}>{r.description}</div>}
                        <div className="flex-gap" style={{ marginTop: 2 }}>
                          {r.needs_review ? <span className="badge badge-review">⚠ Check</span> : null}
                          {excluded && (
                            <span className="badge badge-excluded">Excluded · {r.matched_txn_id ? 'matched' : 'unmatched'}</span>
                          )}
                        </div>
                      </td>
                      <td className="hide-mobile">
                        {r.source_name || 'Unlinked source'}
                        <div className="muted-note" style={{ fontSize: 11 }}>{r.family_member}</div>
                      </td>
                      <td style={{ textAlign: 'right' }} className={`amount${r.direction === 'credit' ? ' positive' : ''}`}>
                        {r.direction === 'credit' ? '+' : '−'}{fmt(r.amount)}
                      </td>
                      <td>
                        <select className="cell-select" value={r.kind} onChange={(e) => edit(r, { kind: e.target.value })}>
                          {KIND_OPTIONS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
                        </select>
                      </td>
                      <td>
                        <select
                          className="cell-select"
                          value={r.category || ''}
                          disabled={excluded}
                          onChange={(e) => edit(r, { category: e.target.value || null })}
                        >
                          <option value="">—</option>
                          {options.map((c) => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card" style={{ marginTop: 16 }}>
        <div className="section-title">Uploaded statements</div>
        {statements.length === 0 ? (
          <p className="muted-note">No statements uploaded yet.</p>
        ) : (
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>Account / card</th>
                  <th>Period</th>
                  <th className="hide-mobile">File</th>
                  <th style={{ textAlign: 'right' }}>Transactions</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {statements.map((s) => (
                  <tr key={s.id}>
                    <td>{s.source_name || 'Unlinked source'}{s.last4 ? ` ··${s.last4}` : ''}</td>
                    <td>{formatDate(s.period_start)} – {formatDate(s.period_end)}</td>
                    <td className="hide-mobile">{s.file_name || '—'}</td>
                    <td style={{ textAlign: 'right' }}>{s.transaction_count}</td>
                    <td><button className="btn-danger btn-sm" onClick={() => removeStatement(s)}>Delete</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <button className="btn-ghost btn-sm" onClick={() => setShowRules((v) => !v)}>
          {showRules ? '▾' : '▸'} Learned merchant rules ({rules.length})
        </button>
        {showRules && (rules.length === 0 ? (
          <p className="muted-note" style={{ marginTop: 8 }}>
            Rules are created when you correct a transaction with “Remember” ticked.
          </p>
        ) : (
          <div className="table-container" style={{ marginTop: 8 }}>
            <table>
              <thead>
                <tr><th>Merchant</th><th>Kind</th><th>Category</th><th /></tr>
              </thead>
              <tbody>
                {rules.map((rule) => (
                  <tr key={rule.id}>
                    <td>{rule.merchant_key}</td>
                    <td>{KIND_LABELS[rule.kind] || rule.kind}</td>
                    <td>{rule.category || '—'}</td>
                    <td><button className="btn-ghost btn-sm" onClick={() => removeRule(rule)}>Forget</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  );
}
