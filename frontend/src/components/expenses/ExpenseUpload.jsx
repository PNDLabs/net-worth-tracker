import { useEffect, useState } from 'react';
import { api } from '../../hooks/apiAdapter';
import { formatCurrency, formatDate } from '../../hooks/format';
import { useCurrency } from '../../hooks/CurrencyContext';
import { KIND_OPTIONS, EXCLUDED_KINDS } from './constants';

const NEW_SOURCE = '__new_source__';
const NEW_CATEGORY = '__new_category__';
const EMPTY_SOURCE = { kind: 'account', name: '', institution: '', family_member: 'Self' };

// Rows that need a look come first, then by date.
function sortForReview(rows) {
  return [...rows].sort((a, b) => (Number(b.needs_review) - Number(a.needs_review)) || a.date.localeCompare(b.date));
}

export default function ExpenseUpload({ onViewTransactions }) {
  const [accounts, setAccounts] = useState([]);
  const [cards, setCards] = useState([]);
  const [categories, setCategories] = useState([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [sourceKey, setSourceKey] = useState('');
  const [newSource, setNewSource] = useState(null);
  const [file, setFile] = useState(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [password, setPassword] = useState('');
  const [preview, setPreview] = useState(null);
  const [rows, setRows] = useState([]);
  const [updateBalance, setUpdateBalance] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(null);
  const { currency } = useCurrency();
  const fmt = (v) => formatCurrency(v, currency);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.getAccounts(), api.getLiabilities(), api.getExpenseCategories()])
      .then(([accs, liabs, cats]) => {
        if (cancelled) return;
        setAccounts(accs);
        setCards(liabs.filter((l) => l.type === 'credit_card'));
        setCategories(cats);
      })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [reloadKey]);

  function sourceName(key) {
    const [type, id] = key.split(':');
    const list = type === 'account' ? accounts : cards;
    return list.find((s) => String(s.id) === id)?.name || '';
  }

  function chooseSource(value) {
    if (value === NEW_SOURCE) {
      setNewSource({ ...EMPTY_SOURCE });
      return;
    }
    setSourceKey(value);
  }

  async function createSource() {
    const name = newSource.name.trim();
    if (!name) { setError('Name is required'); return; }
    try {
      setError('');
      const created = newSource.kind === 'account'
        ? await api.createAccount({ name, institution: newSource.institution || null, type: 'savings', balance: 0, family_member: newSource.family_member })
        : await api.createLiability({ name, lender: newSource.institution || null, type: 'credit_card', current_balance: 0, family_member: newSource.family_member });
      setSourceKey(`${newSource.kind}:${created.id}`);
      setNewSource(null);
      setReloadKey((k) => k + 1);
    } catch (e) {
      setError(e.message);
    }
  }

  async function runPreview() {
    if (!file || !sourceKey) {
      setError('Choose a statement file and the account or card it belongs to.');
      return;
    }
    const [sourceType, sourceId] = sourceKey.split(':');
    setBusy(true);
    setError('');
    setSaved(null);
    setPreview(null);
    try {
      const p = await api.previewExpenseStatement(file, { sourceType, sourceId, password });
      setPreview({ ...p, sourceType, sourceId: Number(sourceId), sourceName: sourceName(sourceKey) });
      setRows(sortForReview(p.transactions).map((t) => ({ ...t, edited: false, remember: true })));
      setUpdateBalance(Boolean(p.balance_update?.default_checked));
    } catch (e) {
      setError(e.code === 'PASSWORD_REQUIRED' ? `🔒 ${e.message}` : e.message);
    } finally {
      setBusy(false);
    }
  }

  function updateRow(key, patch) {
    setRows((current) => current.map((r) => {
      if (r.dedupe_key !== key) return r;
      const next = { ...r, ...patch, edited: true, needs_review: false };
      if (EXCLUDED_KINDS.includes(next.kind)) next.category = null;
      else if (next.kind === 'expense' && !next.category) next.category = 'Other';
      return next;
    }));
  }

  function chooseCategory(key, value) {
    if (value !== NEW_CATEGORY) {
      updateRow(key, { category: value || null });
      return;
    }
    const name = (window.prompt('New category name') || '').trim();
    if (!name) return;
    setCategories((cs) => (cs.includes(name) ? cs : [...cs, name]));
    updateRow(key, { category: name });
  }

  function setRemember(key, remember) {
    setRows((current) => current.map((r) => (r.dedupe_key === key ? { ...r, remember } : r)));
  }

  async function save(force = false) {
    const toSave = rows.filter((r) => !r.duplicate);
    if (toSave.length === 0) {
      setError('Every transaction in this statement is already saved.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await api.commitExpenseStatement({
        source_type: preview.sourceType,
        source_id: preview.sourceId,
        statement: { ...preview.statement, parse_method: preview.method },
        transactions: toSave.map(({ date, description, merchant, amount, direction, kind, category, needs_review, edited, remember, dedupe_key }) =>
          ({ date, description, merchant, amount, direction, kind, category, needs_review, edited, remember, dedupe_key })),
        update_balance: updateBalance,
        force_balance: force,
      });
      setSaved({ ...result, month: (preview.statement.period_end || toSave[0].date).slice(0, 7) });
      setPreview(null);
      setRows([]);
      setFile(null);
      setFileInputKey((k) => k + 1);
      setPassword('');
    } catch (e) {
      if (e.code === 'STALE_BALANCE' && !force && window.confirm(`${e.message}\n\nUpdate the balance anyway?`)) {
        await save(true);
        return;
      }
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const saveable = rows.filter((r) => !r.duplicate);
  const sumKind = (kind) => saveable.filter((r) => r.kind === kind).reduce((s, r) => s + r.amount, 0);
  const spending = sumKind('expense') - sumKind('refund');
  const excludedCount = saveable.filter((r) => EXCLUDED_KINDS.includes(r.kind)).length;
  const reviewCount = saveable.filter((r) => r.needs_review).length;
  const duplicateCount = rows.length - saveable.length;
  const matched = saved ? saved.matches.card_payments + saved.matches.promoted : 0;

  return (
    <div>
      {error && <div className="error-msg">{error}</div>}
      {saved && (
        <div className="success-msg flex-gap" style={{ justifyContent: 'space-between' }}>
          <span>
            Saved {saved.inserted} transactions
            {saved.duplicates ? ` · ${saved.duplicates} already saved` : ''}
            {saved.rules_learned ? ` · ${saved.rules_learned} merchant rules learned` : ''}
            {matched ? ` · ${matched} card payments matched` : ''}
            {saved.matches.transfers ? ` · ${saved.matches.transfers} transfers matched` : ''}
            {saved.balance_updated ? ' · balance updated' : ''}
          </span>
          <button className="btn-ghost btn-sm" onClick={() => onViewTransactions(saved.month)}>View transactions</button>
        </div>
      )}

      <div className="card mb-4">
        <div className="section-title">Upload a statement</div>
        <div className="form-row">
          <div className="form-group">
            <label>Statement belongs to *</label>
            <select value={sourceKey} onChange={(e) => chooseSource(e.target.value)}>
              <option value="">Choose the account or card…</option>
              <optgroup label="Bank accounts">
                {accounts.map((a) => (
                  <option key={`account-${a.id}`} value={`account:${a.id}`}>{a.name}{a.institution ? ` · ${a.institution}` : ''}</option>
                ))}
              </optgroup>
              <optgroup label="Credit cards">
                {cards.map((c) => (
                  <option key={`card-${c.id}`} value={`liability:${c.id}`}>{c.name}{c.lender ? ` · ${c.lender}` : ''}</option>
                ))}
              </optgroup>
              <option value={NEW_SOURCE}>＋ Add a new account or card…</option>
            </select>
          </div>
          <div className="form-group">
            <label>Statement file (PDF or CSV) *</label>
            <input
              key={fileInputKey}
              type="file"
              accept=".pdf,.csv,application/pdf,text/csv"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
            />
          </div>
          <div className="form-group">
            <label>PDF password</label>
            <input
              type="password"
              autoComplete="off"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Leave blank if not protected"
            />
          </div>
        </div>

        {newSource && (
          <div className="card mb-4" style={{ background: 'var(--color-surface-2)' }}>
            <div className="form-row">
              <div className="form-group">
                <label>Type</label>
                <select value={newSource.kind} onChange={(e) => setNewSource({ ...newSource, kind: e.target.value })}>
                  <option value="account">Bank account</option>
                  <option value="liability">Credit card</option>
                </select>
              </div>
              <div className="form-group">
                <label>Name *</label>
                <input
                  value={newSource.name}
                  onChange={(e) => setNewSource({ ...newSource, name: e.target.value })}
                  placeholder={newSource.kind === 'account' ? 'HDFC Savings' : 'HDFC Regalia'}
                />
              </div>
              <div className="form-group">
                <label>{newSource.kind === 'account' ? 'Bank' : 'Card issuer'}</label>
                <input value={newSource.institution} onChange={(e) => setNewSource({ ...newSource, institution: e.target.value })} />
              </div>
              <div className="form-group">
                <label>Family member</label>
                <input
                  value={newSource.family_member}
                  onChange={(e) => setNewSource({ ...newSource, family_member: e.target.value })}
                  placeholder="Self / Spouse / Child"
                />
              </div>
            </div>
            <div className="flex-gap">
              <button className="btn-primary btn-sm" onClick={createSource}>Create</button>
              <button className="btn-ghost btn-sm" onClick={() => setNewSource(null)}>Cancel</button>
            </div>
          </div>
        )}

        <button className="btn-primary" disabled={busy || !file || !sourceKey} onClick={runPreview}>
          {busy && !preview ? 'Reading statement…' : 'Preview transactions'}
        </button>
      </div>

      {preview && (
        <div className="card">
          <div className="section-title">Review before saving</div>
          <p className="muted-note mb-4">
            {preview.statement.statement_type === 'credit_card' ? 'Credit card statement' : 'Bank statement'} · {preview.sourceName}
            {preview.statement.last4 ? ` ··${preview.statement.last4}` : ''}
            {preview.statement.period_start ? ` · ${formatDate(preview.statement.period_start)} – ${formatDate(preview.statement.period_end)}` : ''}
            {` · read by ${preview.method === 'ai' ? 'AI' : 'pattern rules'}`}
          </p>
          {preview.validation_notes.length > 0 && (
            <ul className="muted-note mb-4" style={{ paddingLeft: 18 }}>
              {preview.validation_notes.map((note, i) => <li key={i}>{note}</li>)}
            </ul>
          )}

          <div className="table-container" style={{ maxHeight: 480, overflowY: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Description</th>
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
                    <tr key={r.dedupe_key} className={r.duplicate ? 'row-duplicate' : r.needs_review ? 'row-review' : ''}>
                      <td>{formatDate(r.date)}</td>
                      <td>
                        <div>{r.merchant || r.description}</div>
                        {r.merchant && <div className="muted-note" style={{ fontSize: 11 }}>{r.description}</div>}
                        <div className="flex-gap" style={{ marginTop: 2 }}>
                          {r.duplicate && <span className="badge badge-duplicate">Already saved</span>}
                          {!r.duplicate && r.needs_review && <span className="badge badge-review">⚠ Check</span>}
                          {excluded && (
                            <span className="badge badge-excluded">Excluded · {r.kind === 'cc_payment' ? 'card payment' : 'own transfer'}</span>
                          )}
                        </div>
                      </td>
                      <td style={{ textAlign: 'right' }} className={`amount${r.direction === 'credit' ? ' positive' : ''}`}>
                        {r.direction === 'credit' ? '+' : '−'}{fmt(r.amount)}
                      </td>
                      <td>
                        <select
                          className="cell-select"
                          value={r.kind}
                          disabled={r.duplicate}
                          onChange={(e) => updateRow(r.dedupe_key, { kind: e.target.value })}
                        >
                          {KIND_OPTIONS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
                        </select>
                      </td>
                      <td>
                        <select
                          className="cell-select"
                          value={r.category || ''}
                          disabled={r.duplicate || excluded}
                          onChange={(e) => chooseCategory(r.dedupe_key, e.target.value)}
                        >
                          <option value="">—</option>
                          {options.map((c) => <option key={c} value={c}>{c}</option>)}
                          <option value={NEW_CATEGORY}>＋ New category…</option>
                        </select>
                        {r.edited && !r.duplicate && (
                          <label className="muted-note flex-gap" style={{ marginTop: 4 }}>
                            <input type="checkbox" checked={r.remember} onChange={(e) => setRemember(r.dedupe_key, e.target.checked)} />
                            Remember for this merchant
                          </label>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {preview.balance_update.eligible && (
            <label className="flex-gap" style={{ margin: '16px 0 8px' }}>
              <input type="checkbox" checked={updateBalance} onChange={(e) => setUpdateBalance(e.target.checked)} />
              <span>
                Update {preview.sourceName} {preview.balance_update.entity_type === 'liability' ? 'outstanding balance' : 'balance'}:{' '}
                {fmt(preview.balance_update.current)} → <strong>{fmt(preview.balance_update.proposed)}</strong> (statement closing balance)
              </span>
            </label>
          )}

          <p className="muted-note" style={{ marginTop: 8 }}>
            {saveable.length} to save
            {duplicateCount ? ` · ${duplicateCount} already saved` : ''}
            {` · spending ${fmt(spending)}`}
            {excludedCount ? ` · ${excludedCount} card payments/transfers excluded` : ''}
            {reviewCount ? ` · ${reviewCount} to check` : ''}
          </p>
          <div className="modal-actions">
            <button className="btn-ghost" onClick={() => { setPreview(null); setRows([]); }}>Discard</button>
            <button className="btn-primary" disabled={busy || saveable.length === 0} onClick={() => save(false)}>
              {busy ? 'Saving…' : `Save ${saveable.length} transactions`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
