import { useEffect, useState } from 'react';
import { api } from '../hooks/apiAdapter';
import { formatCurrency, formatDate } from '../hooks/format';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend,
} from 'recharts';

export default function HistoryPage() {
  const [snapshots, setSnapshots] = useState([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');

  const load = () => api.getSnapshots().then(setSnapshots).finally(() => setLoading(false));
  useEffect(() => { load(); }, []);

  async function record() {
    try {
      await api.createSnapshot({});
      setMsg('Snapshot recorded!');
      load();
      setTimeout(() => setMsg(''), 3000);
    } catch (e) { setMsg(`Error: ${e.message}`); }
  }

  const chartData = [...snapshots].reverse();

  if (loading) return <div className="loading-center"><div className="spinner" /></div>;

  return (
    <div>
      <div className="page-header">
        <h2>Net Worth History</h2>
        <div className="flex-gap">
          {msg && <span className={msg.startsWith('Error') ? 'error-msg' : 'success-msg'} style={{ margin: 0 }}>{msg}</span>}
          <button className="btn-primary" onClick={record}>📸 Record Snapshot</button>
        </div>
      </div>

      {chartData.length > 1 ? (
        <div className="card mb-4">
          <div className="section-title">Net Worth Over Time</div>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={chartData} margin={{ top: 5, right: 20, bottom: 5, left: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis dataKey="snapshot_date" tick={{ fontSize: 11 }} />
              <YAxis tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} tick={{ fontSize: 11 }} />
              <Tooltip formatter={(v) => formatCurrency(v)} />
              <Legend />
              <Line type="monotone" dataKey="total_assets" name="Total Assets" stroke="#28a745" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="total_liabilities" name="Total Liabilities" stroke="#d73a49" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="net_worth" name="Net Worth" stroke="#0366d6" strokeWidth={2.5} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="card mb-4 empty-state">
          <div className="icon">📈</div>
          <p>Record at least 2 snapshots to see the chart.</p>
        </div>
      )}

      <div className="card">
        <div className="section-title">Snapshot History</div>
        {snapshots.length === 0 ? (
          <div className="empty-state"><p>No snapshots yet. Click "Record Snapshot" above.</p></div>
        ) : (
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th style={{ textAlign: 'right' }}>Total Assets</th>
                  <th style={{ textAlign: 'right' }}>Total Liabilities</th>
                  <th style={{ textAlign: 'right' }}>Net Worth</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {snapshots.map((s) => (
                  <tr key={s.id}>
                    <td>{formatDate(s.snapshot_date)}</td>
                    <td style={{ textAlign: 'right' }} className="amount positive">{formatCurrency(s.total_assets)}</td>
                    <td style={{ textAlign: 'right' }} className="amount negative">{formatCurrency(s.total_liabilities)}</td>
                    <td className="amount" style={{ textAlign: 'right', color: 'var(--color-net)', fontWeight: 700 }}>{formatCurrency(s.net_worth)}</td>
                    <td>{s.notes || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
