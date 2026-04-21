import { useState } from 'react';
import Dashboard from './pages/Dashboard';
import AccountsPage from './pages/AccountsPage';
import AssetsPage from './pages/AssetsPage';
import LiabilitiesPage from './pages/LiabilitiesPage';
import InsurancePage from './pages/InsurancePage';
import HistoryPage from './pages/HistoryPage';
import ImportPage from './pages/ImportPage';

const NAV_ITEMS = [
  { id: 'dashboard',    label: 'Dashboard',    icon: '📊' },
  { id: 'accounts',     label: 'Accounts',     icon: '🏦' },
  { id: 'assets',       label: 'Assets',       icon: '🏠' },
  { id: 'liabilities',  label: 'Liabilities',  icon: '💳' },
  { id: 'insurance',    label: 'Insurance',    icon: '🛡️' },
  { id: 'history',      label: 'History',      icon: '📈' },
  { id: 'import',       label: 'Import',       icon: '📥' },
];

const PAGES = {
  dashboard:   Dashboard,
  accounts:    AccountsPage,
  assets:      AssetsPage,
  liabilities: LiabilitiesPage,
  insurance:   InsurancePage,
  history:     HistoryPage,
  import:      ImportPage,
};

export default function App() {
  const [page, setPage] = useState('dashboard');
  const [refreshKey, setRefreshKey] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const refresh = () => setRefreshKey((k) => k + 1);
  const PageComponent = PAGES[page];

  const navigate = (id) => {
    setPage(id);
    setSidebarOpen(false);
  };

  return (
    <div className="app-layout">
      {/* Hamburger toggle (visible on mobile only) */}
      <button
        className="sidebar-toggle"
        aria-label="Open navigation menu"
        onClick={() => setSidebarOpen((o) => !o)}
      >
        {sidebarOpen ? '✕' : '☰'}
      </button>

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
      </aside>

      <main className="main-content">
        <PageComponent key={refreshKey} onRefresh={refresh} navigate={navigate} />
      </main>
    </div>
  );
}
