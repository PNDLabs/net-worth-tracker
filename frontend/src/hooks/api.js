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

  // Insurance Plans
  getInsurance: () => apiFetch('/insurance'),
  createInsurance: (data) => apiFetch('/insurance', { method: 'POST', body: JSON.stringify(data) }),
  updateInsurance: (id, data) => apiFetch(`/insurance/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteInsurance: (id) => apiFetch(`/insurance/${id}`, { method: 'DELETE' }),

  // Settings
  getSettings: () => apiFetch('/settings'),
  updateSettings: (data) => apiFetch('/settings', { method: 'PATCH', body: JSON.stringify(data) }),

  // Server config
  getConfig: () => apiFetch('/config'),

  // Net Worth
  getNetWorth: () => apiFetch('/networth'),
  getSnapshots: () => apiFetch('/networth/snapshots'),
  createSnapshot: (data) => apiFetch('/networth/snapshots', { method: 'POST', body: JSON.stringify(data) }),

  // Value History
  getValueHistory: (entityType, entityId) => apiFetch(`/value-history?entity_type=${entityType}&entity_id=${entityId}`),
  getValueGrowth: (entityType, entityId) => apiFetch(`/value-history/growth?entity_type=${entityType}&entity_id=${entityId}`),
  recordValue: (data) => apiFetch('/value-history', { method: 'POST', body: JSON.stringify(data) }),

  // SIP Installments
  getSipInstallments: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return apiFetch(`/sip${qs ? '?' + qs : ''}`);
  },
  getSipSummary: () => apiFetch('/sip/summary'),
  createSipInstallment: (data) => apiFetch('/sip', { method: 'POST', body: JSON.stringify(data) }),
  updateSipInstallment: (id, data) => apiFetch(`/sip/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteSipInstallment: (id) => apiFetch(`/sip/${id}`, { method: 'DELETE' }),

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

  previewPdf: async (file, password) => {
    const formData = new FormData();
    formData.append('file', file);
    if (password) formData.append('password', password);
    const res = await fetch(`${API_BASE}/import/pdf/preview`, { method: 'POST', body: formData });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const err = new Error(body.error || `Request failed: ${res.status}`);
      err.code = body.code;
      throw err;
    }
    return res.json();
  },

  importPdf: async (file, password, importType, previewedRecords) => {
    const formData = new FormData();
    formData.append('file', file);
    if (password) formData.append('password', password);
    if (importType) formData.append('import_type', importType);
    if (previewedRecords) formData.append('previewed_records', JSON.stringify(previewedRecords));
    const res = await fetch(`${API_BASE}/import/pdf`, { method: 'POST', body: formData });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const err = new Error(body.error || `Request failed: ${res.status}`);
      err.code = body.code;
      throw err;
    }
    return res.json();
  },

  parseText: (text, importType) =>
    apiFetch('/import/text', {
      method: 'POST',
      body: JSON.stringify({ text, import_type: importType }),
    }),

  // Export / import full data
  exportData: () => apiFetch('/export'),

  importFullData: (payload) =>
    apiFetch('/export/import', { method: 'POST', body: JSON.stringify(payload) }),
};
