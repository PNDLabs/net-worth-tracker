import { useState } from 'react';
import ExpenseOverview from '../components/expenses/ExpenseOverview';
import ExpenseTransactions from '../components/expenses/ExpenseTransactions';
import ExpenseUpload from '../components/expenses/ExpenseUpload';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'transactions', label: 'Transactions' },
  { id: 'upload', label: 'Upload' },
];

export default function ExpensesPage() {
  const [tab, setTab] = useState('overview');
  const [txnFilter, setTxnFilter] = useState({});

  const openTransactions = (filter) => {
    setTxnFilter(filter);
    setTab('transactions');
  };

  return (
    <div>
      <div className="page-header">
        <h2>Expenses</h2>
      </div>

      <div className="tab-bar" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`tab-btn${tab === t.id ? ' active' : ''}`}
            onClick={() => { setTxnFilter({}); setTab(t.id); }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && <ExpenseOverview onOpenTransactions={openTransactions} />}
      {tab === 'transactions' && <ExpenseTransactions initialFilter={txnFilter} />}
      {tab === 'upload' && <ExpenseUpload onViewTransactions={(month) => openTransactions({ month })} />}
    </div>
  );
}
