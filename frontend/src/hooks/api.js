const API_BASE = '/api';

export async function apiFetch(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

export const api = {
  // Accounts
  getAccounts: () => apiFetch('/accounts'),
  createAccount: (data) => apiFetch('/accounts', { method: 'POST', body: JSON.stringify(data) }),
  updateAccount: (id, data) => apiFetch(`/accounts/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteAccount: (id) => apiFetch(`/accounts/${id}`, { method: 'DELETE' }),
  getHoldings: (id) => apiFetch(`/accounts/${id}/holdings`),
  createHolding: (id, data) => apiFetch(`/accounts/${id}/holdings`, { method: 'POST', body: JSON.stringify(data) }),

  // Assets
  getAssets: () => apiFetch('/assets'),
  createAsset: (data) => apiFetch('/assets', { method: 'POST', body: JSON.stringify(data) }),
  updateAsset: (id, data) => apiFetch(`/assets/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteAsset: (id) => apiFetch(`/assets/${id}`, { method: 'DELETE' }),

  // Liabilities
  getLiabilities: () => apiFetch('/liabilities'),
  createLiability: (data) => apiFetch('/liabilities', { method: 'POST', body: JSON.stringify(data) }),
  updateLiability: (id, data) => apiFetch(`/liabilities/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteLiability: (id) => apiFetch(`/liabilities/${id}`, { method: 'DELETE' }),

  // Net Worth
  getNetWorth: () => apiFetch('/networth'),
  getSnapshots: () => apiFetch('/networth/snapshots'),
  createSnapshot: (data) => apiFetch('/networth/snapshots', { method: 'POST', body: JSON.stringify(data) }),

  // Import
  importJson: (importType, records) =>
    apiFetch('/import/json', { method: 'POST', body: JSON.stringify({ import_type: importType, records }) }),

  importCsv: async (importType, file) => {
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch(`${API_BASE}/import/csv?import_type=${importType}`, {
      method: 'POST',
      body: formData,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Request failed: ${res.status}`);
    }
    return res.json();
  },
};
