import { useState } from 'react';
import Dashboard from './pages/Dashboard';
import AccountsPage from './pages/AccountsPage';
import AssetsPage from './pages/AssetsPage';
import LiabilitiesPage from './pages/LiabilitiesPage';
import InsurancePage from './pages/InsurancePage';
import HistoryPage from './pages/HistoryPage';
import ImportPage from './pages/ImportPage';
import MetalsPage from './pages/MetalsPage';
import SettingsPage from './pages/SettingsPage';
import { CurrencyProvider, useCurrency } from './hooks/CurrencyContext';
import { APP_VERSION } from './version';

const NAV_ITEMS = [
  { id: 'dashboard',    label: 'Dashboard',    icon: '📊' },
  { id: 'accounts',     label: 'Accounts',     icon: '🏦' },
  { id: 'assets',       label: 'Assets',       icon: '🏠' },
  { id: 'metals',       label: 'Metals',       icon: '🥇' },
  { id: 'liabilities',  label: 'Liabilities',  icon: '💳' },
  { id: 'insurance',    label: 'Insurance',    icon: '🛡️' },
  { id: 'history',      label: 'History',      icon: '📈' },
  { id: 'import',       label: 'Import',       icon: '📥' },
  { id: 'settings',     label: 'Settings',     icon: '⚙️' },
];

// Primary tabs shown in the mobile bottom nav bar
const BOTTOM_NAV_ITEMS = [
  { id: 'dashboard',   label: 'Dashboard',  icon: '📊' },
  { id: 'accounts',    label: 'Accounts',   icon: '🏦' },
  { id: 'assets',      label: 'Assets',     icon: '🏠' },
  { id: 'liabilities', label: 'Debts',      icon: '💳' },
];

const PAGES = {
  dashboard:   Dashboard,
  accounts:    AccountsPage,
  assets:      AssetsPage,
  metals:      MetalsPage,
  liabilities: LiabilitiesPage,
  insurance:   InsurancePage,
  history:     HistoryPage,
  import:      ImportPage,
  settings:    SettingsPage,
};

const COMMON_CURRENCIES = [
  'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CNY', 'INR', 'BRL', 'MXN',
  'SGD', 'HKD', 'CHF', 'KRW', 'NOK', 'SEK', 'DKK', 'NZD', 'ZAR', 'AED',
  'SAR', 'TRY', 'RUB', 'PLN', 'THB', 'IDR', 'MYR', 'PHP', 'TWD', 'NGN',
];

function CurrencyModal({ onClose }) {
  const { currency, setCurrency } = useCurrency();
  const [input, setInput] = useState(currency);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 360 }}>
        <h3>⚙️ Currency Settings</h3>
        <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 16 }}>
          Choose the currency used throughout the app for display and default imports.
        </p>
        <div className="form-group mb-4">
          <label>Default Currency</label>
          <select value={input} onChange={(e) => setInput(e.target.value)}>
            {COMMON_CURRENCIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
        <div className="form-group mb-4">
          <label>Or enter a custom code</label>
          <input
            value={input}
            maxLength={3}
            style={{ textTransform: 'uppercase' }}
            onChange={(e) => setInput(e.target.value.toUpperCase())}
            placeholder="e.g. CHF"
          />
        </div>
        <div className="modal-actions">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={() => { if (input.trim()) { setCurrency(input.trim()); } onClose(); }}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function AppInner() {
  const [page, setPage] = useState('dashboard');
  const [refreshKey, setRefreshKey] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showCurrencyModal, setShowCurrencyModal] = useState(false);
  const { currency } = useCurrency();

  const refresh = () => setRefreshKey((k) => k + 1);
  const PageComponent = PAGES[page];

  const navigate = (id) => {
    setPage(id);
    setSidebarOpen(false);
  };

  return (
    <div className="app-layout">
      {/* Overlay that closes sidebar on tap */}
      <div
        className={`sidebar-overlay${sidebarOpen ? ' open' : ''}`}
        onClick={() => setSidebarOpen(false)}
      />

      <aside className={`sidebar${sidebarOpen ? ' open' : ''}`}>
        <div className="sidebar-logo">
          <h1>💰 NetWorth</h1>
          <p>Personal Finance Tracker</p>
        </div>
        <nav className="sidebar-nav">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              className={`nav-item${page === item.id ? ' active' : ''}`}
              onClick={() => navigate(item.id)}
            >
              <span className="icon">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>
        <div style={{ borderTop: '1px solid var(--color-border)', padding: '12px 16px', marginTop: 'auto' }}>
          <button
            className="btn-ghost"
            style={{ width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}
            onClick={() => setShowCurrencyModal(true)}
          >
            <span>⚙️</span>
            <span>Currency: <strong>{currency}</strong></span>
          </button>
          <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 6, paddingLeft: 2 }}>
            v{APP_VERSION}
          </div>
        </div>
      </aside>

      <main className="main-content">
        <PageComponent key={refreshKey} onRefresh={refresh} navigate={navigate} />
      </main>

      {/* Bottom navigation bar – visible on mobile only */}
      <nav className="bottom-nav">
        {BOTTOM_NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            className={`bottom-nav-item${page === item.id ? ' active' : ''}`}
            onClick={() => navigate(item.id)}
          >
            <span className="nav-icon">{item.icon}</span>
            {item.label}
          </button>
        ))}
        <button
          className={`bottom-nav-item${!BOTTOM_NAV_ITEMS.some(i => i.id === page) ? ' active' : ''}`}
          onClick={() => setSidebarOpen((o) => !o)}
        >
          <span className="nav-icon">{sidebarOpen ? '✕' : '☰'}</span>
          More
        </button>
      </nav>

      {showCurrencyModal && <CurrencyModal onClose={() => setShowCurrencyModal(false)} />}
    </div>
  );
}

export default function App() {
  return (
    <CurrencyProvider>
      <AppInner />
    </CurrencyProvider>
  );
}
