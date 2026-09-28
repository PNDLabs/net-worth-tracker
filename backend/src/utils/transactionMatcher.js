/**
 * transactionMatcher.js – pairs credit card bill payments and own-account transfers so
 * they are never counted as spending. Runs on every commit (inside the caller's DB
 * transaction), so the order in which bank and card statements are uploaded does not matter.
 */
const { mentionsLast4 } = require('./transactionClassifier');

const AMOUNT_TOLERANCE = 1;   // ₹1 rounding slack
const CARD_PAYMENT_DAYS = 5;  // bank debit → card credit posting lag
const TRANSFER_DAYS = 3;

const dayDiff = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400000;
const amountEq = (a, b) => Math.abs(a - b) <= AMOUNT_TOLERANCE;

/**
 * @param {import('better-sqlite3').Database} conn
 * @param {{from: string, to: string}} window  ISO dates bounding the rows to consider
 * @returns {{card_payments: number, promoted: number, transfers: number}}
 */
function runMatcher(conn, { from, to }) {
  const rows = conn.prepare(
    `SELECT t.*, s.statement_type, s.last4 AS statement_last4
       FROM transactions t
       JOIN expense_statements s ON s.id = t.statement_id
      WHERE t.txn_date BETWEEN ? AND ? AND t.matched_txn_id IS NULL
      ORDER BY t.txn_date, t.id`
  ).all(from, to);

  const setMatch = conn.prepare(`UPDATE transactions SET matched_txn_id = ?, updated_at = datetime('now') WHERE id = ?`);
  const setKind = conn.prepare(
    `UPDATE transactions SET kind = ?, category = NULL, needs_review = ?, updated_at = datetime('now') WHERE id = ?`
  );
  const used = new Set();
  const link = (a, b) => {
    setMatch.run(b.id, a.id);
    setMatch.run(a.id, b.id);
    used.add(a.id);
    used.add(b.id);
  };
  const result = { card_payments: 0, promoted: 0, transfers: 0 };

  const bankDebits = rows.filter((r) => r.statement_type === 'bank' && r.direction === 'debit');
  const bankCredits = rows.filter((r) => r.statement_type === 'bank' && r.direction === 'credit');
  const cardPayments = rows.filter((r) => r.statement_type === 'credit_card' && r.direction === 'credit' && r.kind === 'cc_payment');

  // Prefer the card whose last4 the bank narration mentions, then the closest date.
  const bestCardPayment = (debit) => {
    const candidates = cardPayments.filter((c) => !used.has(c.id) &&
      amountEq(c.amount, debit.amount) && dayDiff(c.txn_date, debit.txn_date) <= CARD_PAYMENT_DAYS);
    candidates.sort((a, b) =>
      (mentionsLast4(debit.description, a.statement_last4) ? 0 : 1) - (mentionsLast4(debit.description, b.statement_last4) ? 0 : 1) ||
      dayDiff(a.txn_date, debit.txn_date) - dayDiff(b.txn_date, debit.txn_date));
    return candidates[0] || null;
  };

  // 1. Pair bank card-payment debits with the card's "payment received" credit.
  for (const debit of bankDebits.filter((r) => r.kind === 'cc_payment')) {
    const credit = bestCardPayment(debit);
    if (credit) { link(debit, credit); result.card_payments++; }
  }

  // 2. A bank debit that was not recognised but exactly matches a card payment is one.
  for (const debit of bankDebits.filter((r) => !used.has(r.id) && r.kind !== 'cc_payment' && r.kind !== 'transfer' && !r.kind_locked)) {
    const credit = bestCardPayment(debit);
    if (credit) {
      setKind.run('cc_payment', 1, debit.id);
      link(debit, credit);
      result.promoted++;
    }
  }

  // 3. Pair transfers between two of the user's bank accounts.
  const canBeTransfer = (r) => r.kind === 'transfer' || !r.kind_locked;
  for (const debit of bankDebits) {
    if (used.has(debit.id) || debit.kind === 'cc_payment' || !canBeTransfer(debit)) continue;
    const credit = bankCredits.find((c) => !used.has(c.id) && canBeTransfer(c) &&
      !(c.source_type === debit.source_type && c.source_id === debit.source_id) &&
      amountEq(c.amount, debit.amount) && dayDiff(c.txn_date, debit.txn_date) <= TRANSFER_DAYS &&
      (debit.kind === 'transfer' || c.kind === 'transfer' ||
       mentionsLast4(debit.description, c.statement_last4) || mentionsLast4(c.description, debit.statement_last4)));
    if (!credit) continue;
    if (debit.kind !== 'transfer') setKind.run('transfer', 0, debit.id);
    if (credit.kind !== 'transfer') setKind.run('transfer', 0, credit.id);
    link(debit, credit);
    result.transfers++;
  }

  return result;
}

module.exports = { runMatcher, CARD_PAYMENT_DAYS, TRANSFER_DAYS };
