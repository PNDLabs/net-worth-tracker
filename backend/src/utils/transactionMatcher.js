/**
 * transactionMatcher.js – pairs credit card bill payments and own-account transfers so
 * they are never counted as spending. Runs on every commit (inside the caller's DB
 * transaction), so the order in which bank and card statements are uploaded does not matter.
 */
const { mentionsLast4, merchantKey } = require('./transactionClassifier');

const AMOUNT_TOLERANCE = 1;   // ₹1 rounding slack
const CARD_PAYMENT_DAYS = 5;  // bank debit → card credit posting lag
const TRANSFER_DAYS = 3;
const REFUND_LOOKBACK_DAYS = 90; // a refund's purchase is on the same account within this many days before it
// Words a refund narration adds to the original purchase's narration.
const REFUND_WORDS_RE = /\b(REFUND|REFUNDED|REVERSAL|REVERSED|REV|CASHBACK|RETURN)\b/gi;

const dayDiff = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400000;
const amountEq = (a, b) => Math.abs(a - b) <= AMOUNT_TOLERANCE;

function shiftDate(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Give each refund in the window the category of the purchase it reverses, so the refund
 * cancels that purchase in the category totals. The purchase is on the same account/card,
 * up to REFUND_LOOKBACK_DAYS before the refund: preferably the same merchant (ignoring
 * REFUND/REVERSAL words) with an amount at least the refund's, otherwise the exact amount.
 * Refunds the user edited (kind_locked) are left alone.
 * @returns {number} refunds whose category was set
 */
function attributeRefunds(conn, { from, to }) {
  const refunds = conn.prepare(
    `SELECT * FROM transactions WHERE kind = 'refund' AND kind_locked = 0 AND txn_date BETWEEN ? AND ?`
  ).all(from, to);
  const purchasesFor = conn.prepare(
    `SELECT * FROM transactions
      WHERE kind = 'expense' AND direction = 'debit' AND category IS NOT NULL
        AND source_type = ? AND source_id = ? AND txn_date BETWEEN ? AND ?`
  );
  const setCategory = conn.prepare(
    `UPDATE transactions SET category = ?, needs_review = CASE WHEN ? = 1 THEN 0 ELSE needs_review END,
            updated_at = datetime('now') WHERE id = ?`
  );
  let attributed = 0;
  for (const refund of refunds) {
    const candidates = purchasesFor.all(refund.source_type, refund.source_id,
      shiftDate(refund.txn_date, -REFUND_LOOKBACK_DAYS), refund.txn_date);
    const key = merchantKey(refund.description.replace(REFUND_WORDS_RE, ' '));
    const sameMerchant = candidates.filter((c) => key &&
      (c.merchant_key || merchantKey(c.description)) === key && c.amount >= refund.amount - AMOUNT_TOLERANCE);
    const pool = sameMerchant.length ? sameMerchant : candidates.filter((c) => amountEq(c.amount, refund.amount));
    if (pool.length === 0) continue;
    pool.sort((a, b) =>
      (amountEq(a.amount, refund.amount) ? 0 : 1) - (amountEq(b.amount, refund.amount) ? 0 : 1) ||
      dayDiff(a.txn_date, refund.txn_date) - dayDiff(b.txn_date, refund.txn_date));
    const purchase = pool[0];
    // A same-merchant match explains the refund, so it no longer needs a look.
    const explained = sameMerchant.length > 0;
    if (purchase.category === refund.category && !(explained && refund.needs_review)) continue;
    setCategory.run(purchase.category, explained ? 1 : 0, refund.id);
    attributed++;
  }
  return attributed;
}

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
  const result = { card_payments: 0, promoted: 0, transfers: 0, refunds: 0 };

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
    const credit = bankCredits
      .filter((c) => !used.has(c.id) && canBeTransfer(c) &&
        !(c.source_type === debit.source_type && c.source_id === debit.source_id) &&
        amountEq(c.amount, debit.amount) && dayDiff(c.txn_date, debit.txn_date) <= TRANSFER_DAYS &&
        (debit.kind === 'transfer' || c.kind === 'transfer' ||
         mentionsLast4(debit.description, c.statement_last4) || mentionsLast4(c.description, debit.statement_last4)))
      .sort((a, b) => dayDiff(a.txn_date, debit.txn_date) - dayDiff(b.txn_date, debit.txn_date))[0];
    if (!credit) continue;
    // A row re-kinded here drops out of the totals (it may have been salary), so flag it.
    if (debit.kind !== 'transfer') setKind.run('transfer', 1, debit.id);
    if (credit.kind !== 'transfer') setKind.run('transfer', 1, credit.id);
    link(debit, credit);
    result.transfers++;
  }

  result.refunds = attributeRefunds(conn, { from, to });
  return result;
}

module.exports = { runMatcher, attributeRefunds, CARD_PAYMENT_DAYS, TRANSFER_DAYS, REFUND_LOOKBACK_DAYS };
