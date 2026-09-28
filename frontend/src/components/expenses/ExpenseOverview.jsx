import { useEffect, useState } from 'react';
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, LabelList, ResponsiveContainer,
} from 'recharts';
import { api } from '../../hooks/apiAdapter';
import { formatCurrency } from '../../hooks/format';
import { useCurrency } from '../../hooks/CurrencyContext';
import { SERIES_COLORS, currentMonth, formatMonth, formatRate } from './constants';

const TREND_SERIES = [
  { key: 'income', label: 'Income', color: SERIES_COLORS.income },
  { key: 'spending', label: 'Spending', color: SERIES_COLORS.spending },
  { key: 'invested', label: 'Invested', color: SERIES_COLORS.invested },
];
const AXIS_TICK = { fontSize: 11, fill: 'var(--color-text-muted)' };
const legendText = (value) => <span style={{ color: 'var(--color-text)' }}>{value}</span>;

function Stat({ label, value, hint }) {
  return (
    <div className="card stat-card">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

export default function ExpenseOverview({ onOpenTransactions }) {
  const [month, setMonth] = useState(currentMonth());
  const [member, setMember] = useState('');
  const [members, setMembers] = useState([]);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [showTable, setShowTable] = useState(false);
  const { currency } = useCurrency();
  const fmt = (v) => formatCurrency(v, currency);
  const compact = (v) => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(v);

  useEffect(() => {
    api.getNetWorth().then((nw) => setMembers((nw.members || []).map((m) => m.name))).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.getExpenseSummary(month, member), api.getExpenseTrend(12, member, month)])
      .then(([summary, trend]) => {
        if (cancelled) return;
        setData({ summary, trend: trend.months });
        setError('');
      })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [month, member]);

  if (error) return <div className="error-msg">{error}</div>;
  if (!data) return <div className="loading-center"><div className="spinner" /></div>;

  const { summary, trend } = data;
  const trendRows = trend.map((m) => ({
    ...m,
    label: formatMonth(m.month),
    savings_pct: m.savings_rate == null ? null : Math.round(m.savings_rate * 100),
  }));
  const trendHasData = trend.some((m) => m.income || m.spending || m.invested);
  const saved = summary.income - summary.spending;

  return (
    <div>
      <div className="filter-row">
        <div className="form-group">
          <label>Month</label>
          <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
        </div>
        <div className="form-group">
          <label>Family member</label>
          <select value={member} onChange={(e) => setMember(e.target.value)}>
            <option value="">All members</option>
            {members.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
        {summary.needs_review_count > 0 && (
          <button className="btn-ghost btn-sm" onClick={() => onOpenTransactions({ month, member, needs_review: '1' })}>
            ⚠ {summary.needs_review_count} transactions to review
          </button>
        )}
      </div>

      <div className="card-grid">
        <Stat label="Income" value={fmt(summary.income)} />
        <Stat label="Spending" value={fmt(summary.spending)} hint={summary.refunds ? `after ${fmt(summary.refunds)} of refunds` : null} />
        <Stat
          label="Invested"
          value={fmt(summary.invested)}
          hint={summary.investment_rate != null ? `${formatRate(summary.investment_rate)} of income` : null}
        />
        <Stat
          label="Savings rate"
          value={formatRate(summary.savings_rate)}
          hint={summary.savings_rate == null ? 'No income this month' : `${fmt(saved)} not spent`}
        />
        <Stat
          label="Net worth change"
          value={summary.net_worth_change == null ? '—' : `${summary.net_worth_change >= 0 ? '+' : ''}${fmt(summary.net_worth_change)}`}
          hint={member
            ? 'Shown for all members only'
            : summary.net_worth_change == null ? 'Record a snapshot before and during the month on the Dashboard' : null}
        />
      </div>

      {summary.excluded.total > 0 && (
        <p className="muted-note mb-4">
          {fmt(summary.excluded.total)} of credit card bill payments and own-account transfers is not counted as spending
          {' '}({summary.excluded.matched_count} matched to a statement, {summary.excluded.unmatched_count} unmatched).
        </p>
      )}

      <div className="card mb-4">
        <div className="section-title">Spending by category · {formatMonth(month)}</div>
        {summary.by_category.length === 0 ? (
          <div className="empty-state">
            <div className="icon">💸</div>
            <p>No spending recorded for {formatMonth(month)}. Upload a bank or credit card statement to get started.</p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={summary.by_category.length * 32 + 24}>
            <BarChart data={summary.by_category} layout="vertical" margin={{ top: 4, right: 88, bottom: 4, left: 8 }}>
              <XAxis type="number" hide />
              <YAxis type="category" dataKey="category" width={130} tick={AXIS_TICK} axisLine={false} tickLine={false} />
              <Tooltip formatter={(v) => [fmt(v), 'Spent']} cursor={{ fill: 'var(--color-surface-2)' }} />
              <Bar dataKey="amount" fill={SERIES_COLORS.spending} radius={[0, 4, 4, 0]} barSize={16} isAnimationActive={false}>
                <LabelList dataKey="amount" position="right" formatter={(v) => fmt(v)} style={{ fontSize: 11, fill: 'var(--color-text)' }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {trendHasData && (
        <div className="card">
          <div className="flex-gap" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
            <div className="section-title" style={{ marginBottom: 0 }}>Last 12 months</div>
            <button className="btn-ghost btn-sm" onClick={() => setShowTable((v) => !v)}>
              {showTable ? 'Show charts' : 'Show as table'}
            </button>
          </div>

          {showTable ? (
            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>Month</th>
                    <th style={{ textAlign: 'right' }}>Income</th>
                    <th style={{ textAlign: 'right' }}>Spending</th>
                    <th style={{ textAlign: 'right' }}>Invested</th>
                    <th style={{ textAlign: 'right' }}>Savings rate</th>
                  </tr>
                </thead>
                <tbody>
                  {[...trend].reverse().map((m) => (
                    <tr key={m.month}>
                      <td>{formatMonth(m.month)}</td>
                      <td style={{ textAlign: 'right' }} className="amount">{fmt(m.income)}</td>
                      <td style={{ textAlign: 'right' }} className="amount">{fmt(m.spending)}</td>
                      <td style={{ textAlign: 'right' }} className="amount">{fmt(m.invested)}</td>
                      <td style={{ textAlign: 'right' }}>{formatRate(m.savings_rate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={trendRows} margin={{ top: 8, right: 16, bottom: 0, left: 8 }} barGap={2} barCategoryGap="20%">
                  <CartesianGrid vertical={false} stroke="var(--color-border)" />
                  <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: 'var(--color-border)' }} />
                  <YAxis tickFormatter={compact} tick={AXIS_TICK} tickLine={false} axisLine={false} width={48} />
                  <Tooltip formatter={(v, name) => [fmt(v), name]} cursor={{ fill: 'var(--color-surface-2)' }} />
                  <Legend formatter={legendText} wrapperStyle={{ fontSize: 12 }} />
                  {TREND_SERIES.map((s) => (
                    <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} radius={[4, 4, 0, 0]} isAnimationActive={false} />
                  ))}
                </BarChart>
              </ResponsiveContainer>

              <div className="section-title" style={{ fontSize: 14, margin: '16px 0 4px' }}>Savings rate</div>
              <ResponsiveContainer width="100%" height={160}>
                <LineChart data={trendRows} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
                  <CartesianGrid vertical={false} stroke="var(--color-border)" />
                  <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: 'var(--color-border)' }} />
                  <YAxis tickFormatter={(v) => `${v}%`} tick={AXIS_TICK} tickLine={false} axisLine={false} width={48} />
                  <Tooltip formatter={(v) => [`${v}%`, 'Savings rate']} />
                  <Line
                    type="monotone"
                    dataKey="savings_pct"
                    name="Savings rate"
                    stroke={SERIES_COLORS.savingsRate}
                    strokeWidth={2}
                    dot={{ r: 4 }}
                    activeDot={{ r: 5 }}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </>
          )}
        </div>
      )}
    </div>
  );
}
