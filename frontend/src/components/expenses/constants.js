/** Shared constants and helpers for the Expenses page. */

export const KIND_OPTIONS = [
  { value: 'expense', label: 'Expense' },
  { value: 'refund', label: 'Refund' },
  { value: 'income', label: 'Income' },
  { value: 'investment', label: 'Investment' },
  { value: 'cc_payment', label: 'Card payment (excluded)' },
  { value: 'transfer', label: 'Own transfer (excluded)' },
];

export const KIND_LABELS = Object.fromEntries(KIND_OPTIONS.map((k) => [k.value, k.label]));

// Never counted in income, spending or invested totals.
export const EXCLUDED_KINDS = ['cc_payment', 'transfer'];

// Categorical slots 1–3 and 7 of the dataviz reference palette (validator: all-pairs PASS on white).
export const SERIES_COLORS = {
  income: '#2a78d6',
  spending: '#eb6834',
  invested: '#1baf7a',
  savingsRate: '#4a3aa7',
};

export function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function formatMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

export const formatRate = (rate) => (rate == null ? '—' : `${Math.round(rate * 100)}%`);
