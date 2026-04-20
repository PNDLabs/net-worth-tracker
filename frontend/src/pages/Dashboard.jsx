import { useEffect, useState } from 'react';
import { api } from '../hooks/api';
import { formatCurrency } from '../hooks/format';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, PieChart, Pie, Cell, Legend,
} from 'recharts';

const COLORS = ['#28a745', '#0366d6', '#f66a0a', '#6f42c1'];

export default function Dashboard({ navigate }) {
  const [summary, setSummary] = useState(null);
  const [snapshots, setSnapshots] = useState([]);
  const [loading, setLoading] = useState(true);
  const [snapshotMsg, setSnapshotMsg] = useState('');

  useEffect(() => {
    Promise.all([api.getNetWorth(), api.getSnapshots()])
      .then(([nw, snaps]) => {
        setSummary(nw);
        setSnapshots(snaps.slice(0, 12).reverse());
      })
      .finally(() => setLoading(false));
  }, []);

  async function handleSnapshot() {
    try {
      await api.createSnapshot({});
      setSnapshotMsg('Snapshot recorded!');
      const snaps = await api.getSnapshots();
      setSnapshots(snaps.slice(0, 12).reverse());
      setTimeout(() => setSnapshotMsg(''), 3000);
    } catch (e) {
      setSnapshotMsg(`Error: ${e.message}`);
    }
  }

  if (loading) return <div className="loading-center"><div className="spinner" /></div>;

  const pieData = summary ? [
    { name: 'Cash & Accounts', value: summary.accountsTotal },
    { name: 'Investments', value: summary.holdingsTotal },
    { name: 'Other Assets', value: summary.assetsTotal },
    { name: 'Liabilities', value: -summary.totalLiabilities },
  ].filter((d) => d.value > 0) : [];

  return (
    <div>
      <div className="page-header">
        <h2>Dashboard</h2>
        <div className="flex-gap">
          {snapshotMsg && <span className={snapshotMsg.startsWith('Error') ? 'error-msg' : 'success-msg'} style={{ margin: 0 }}>{snapshotMsg}</span>}
          <button className="btn-primary" onClick={handleSnapshot}>📸 Record Snapshot</button>
        </div>
      </div>

      <div className="card-grid">
        <div className="card stat-card assets">
          <div className="label">Total Assets</div>
          <div className="value">{formatCurrency(summary?.totalAssets)}</div>
        </div>
        <div className="card stat-card liabilities">
          <div className="label">Total Liabilities</div>
          <div className="value">{formatCurrency(summary?.totalLiabilities)}</div>
        </div>
        <div className="card stat-card net">
          <div className="label">Net Worth</div>
          <div className="value">{formatCurrency(summary?.netWorth)}</div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24 }}>
        {/* Asset breakdown */}
        <div className="card">
          <div className="section-title">Asset Breakdown</div>
          {pieData.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80} label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}>
                  {pieData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Pie>
                <Tooltip formatter={(v) => formatCurrency(v)} />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="empty-state"><p>No data yet. Add accounts, assets, or liabilities.</p></div>
          )}
        </div>

        {/* Net worth details */}
        <div className="card">
          <div className="section-title">Breakdown</div>
          <table>
            <tbody>
              <tr><td>Cash &amp; Accounts</td><td className="amount positive" style={{ textAlign: 'right' }}>{formatCurrency(summary?.accountsTotal)}</td></tr>
              <tr><td>Investment Holdings</td><td className="amount positive" style={{ textAlign: 'right' }}>{formatCurrency(summary?.holdingsTotal)}</td></tr>
              <tr><td>Other Assets</td><td className="amount positive" style={{ textAlign: 'right' }}>{formatCurrency(summary?.assetsTotal)}</td></tr>
              <tr style={{ borderTop: '2px solid var(--color-border)' }}><td><strong>Total Assets</strong></td><td className="amount positive" style={{ textAlign: 'right' }}><strong>{formatCurrency(summary?.totalAssets)}</strong></td></tr>
              <tr><td>Total Liabilities</td><td className="amount negative" style={{ textAlign: 'right' }}>−{formatCurrency(summary?.totalLiabilities)}</td></tr>
              <tr style={{ borderTop: '2px solid var(--color-border)' }}><td><strong>Net Worth</strong></td><td className="amount" style={{ textAlign: 'right', color: 'var(--color-net)' }}><strong>{formatCurrency(summary?.netWorth)}</strong></td></tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Trend chart */}
      <div className="card">
        <div className="section-title">Net Worth Trend</div>
        {snapshots.length > 1 ? (
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={snapshots} margin={{ top: 5, right: 20, bottom: 5, left: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis dataKey="snapshot_date" tick={{ fontSize: 11 }} />
              <YAxis tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} tick={{ fontSize: 11 }} />
              <Tooltip formatter={(v) => formatCurrency(v)} />
              <Legend />
              <Line type="monotone" dataKey="total_assets" name="Assets" stroke="#28a745" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="total_liabilities" name="Liabilities" stroke="#d73a49" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="net_worth" name="Net Worth" stroke="#0366d6" strokeWidth={2.5} />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div className="empty-state">
            <div className="icon">📈</div>
            <p>Record at least 2 snapshots to see the trend chart.</p>
          </div>
        )}
      </div>
    </div>
  );
}
