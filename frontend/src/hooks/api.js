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

/** Build a query string, dropping empty values. */
function qs(params = {}) {
  return new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
  ).toString();
}

/** Like apiFetch, but keeps the server's error `code` (PASSWORD_REQUIRED, STALE_BALANCE). */
async function fetchWithCode(path, options) {
  const res = await fetch(`${API_BASE}${path}`, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || `Request failed: ${res.status}`);
    err.code = body.code;
    throw err;
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

  // Precious Metals
  getMetals: () => apiFetch('/metals'),
  createMetal: (data) => apiFetch('/metals', { method: 'POST', body: JSON.stringify(data) }),
  updateMetal: (id, data) => apiFetch(`/metals/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteMetal: (id) => apiFetch(`/metals/${id}`, { method: 'DELETE' }),
  getMetalSpotPrices: () => apiFetch('/metals/spot-prices'),
  refreshMetalPrices: () => apiFetch('/metals/refresh-prices', { method: 'POST' }),

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
  createAssetFromInsurance: (id) => apiFetch(`/insurance/${id}/create-asset`, { method: 'POST' }),
  createFundAccountFromInsurance: (id) => apiFetch(`/insurance/${id}/create-fund-account`, { method: 'POST' }),
  queryInsuranceCoverage: (question) => apiFetch('/insurance/query', { method: 'POST', body: JSON.stringify({ question }) }),
  analyzeInsuranceCoverage: () => apiFetch('/insurance/analysis'),

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

  previewCsv: async (importType, file) => {
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch(`${API_BASE}/import/csv/preview?import_type=${importType}`, {
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

  checkDuplicates: (importType, records) =>
    apiFetch('/import/check-duplicates', {
      method: 'POST',
      body: JSON.stringify({ import_type: importType, records }),
    }),

  // Export / import full data
  exportData: () => apiFetch('/export'),

  importFullData: (payload) =>
    apiFetch('/export/import', { method: 'POST', body: JSON.stringify(payload) }),

  // Expenses
  previewExpenseStatement: (file, { sourceType, sourceId, password }) => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('source_type', sourceType);
    formData.append('source_id', String(sourceId));
    if (password) formData.append('password', password);
    return fetchWithCode('/expenses/preview', { method: 'POST', body: formData });
  },
  commitExpenseStatement: (payload) => fetchWithCode('/expenses/commit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }),
  getExpenseSummary: (month, member) => apiFetch(`/expenses/summary?${qs({ month, member })}`),
  getExpenseTrend: (months, member, end) => apiFetch(`/expenses/trend?${qs({ months, member, end })}`),
  getExpenseTransactions: (filters) => apiFetch(`/expenses/transactions?${qs(filters)}`),
  updateExpenseTransaction: (id, data) => apiFetch(`/expenses/transactions/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  getExpenseStatements: () => apiFetch('/expenses/statements'),
  deleteExpenseStatement: (id) => apiFetch(`/expenses/statements/${id}`, { method: 'DELETE' }),
  getExpenseCategories: () => apiFetch('/expenses/categories'),
  getMerchantRules: () => apiFetch('/expenses/rules'),
  deleteMerchantRule: (id) => apiFetch(`/expenses/rules/${id}`, { method: 'DELETE' }),
};
