/**
 * expenses.js – monthly expense tracking from bank and credit card statements.
 *
 * Routes:
 *   POST   /api/expenses/preview           – parse an uploaded statement (nothing saved)
 *   POST   /api/expenses/commit            – save reviewed transactions, learn rules,
 *                                            pair card payments/transfers, update balance
 *   GET    /api/expenses/summary           – one month's totals
 *   GET    /api/expenses/trend             – monthly series
 *   GET    /api/expenses/transactions      – filtered list
 *   PUT    /api/expenses/transactions/:id  – change kind/category (optionally learn a rule)
 *   GET    /api/expenses/statements        – uploaded statements
 *   DELETE /api/expenses/statements/:id    – undo an upload
 *   GET    /api/expenses/rules             – learned merchant rules
 *   DELETE /api/expenses/rules/:id
 *   GET    /api/expenses/categories        – default + in-use categories
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../db/database');
const pdfExtractor = require('../utils/pdfExtractor');
const { parseTransactionsFromPages, parseTransactionsFromCsv, parseTxnDate } = require('../utils/transactionParser');
const {
  KINDS, EXCLUDED_KINDS, merchantKey, applyPostProcessing, computeDedupeKeys, reconciliationNote,
} = require('../utils/transactionClassifier');
const { runMatcher } = require('../utils/transactionMatcher');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

// The matcher looks this many days beyond the committed rows for partners.
const MATCH_WINDOW_DAYS = 10;

const UPSERT_RULE_SQL =
  `INSERT INTO merchant_rules (merchant_key, kind, category) VALUES (?, ?, ?)
   ON CONFLICT(merchant_key) DO UPDATE SET kind = excluded.kind, category = excluded.category, updated_at = datetime('now')`;

const today = () => new Date().toISOString().slice(0, 10);

function shiftDate(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const isPdf = (file) => /pdf/i.test(file.mimetype || '') || /\.pdf$/i.test(file.originalname || '');
const isCsv = (file) => /csv|text\/plain|ms-excel/i.test(file.mimetype || '') || /\.csv$/i.test(file.originalname || '');

/**
 * Validate the statement's linked source. Bank statements link to an account and card
 * statements to a credit_card liability.
 * @returns {{source, statementType, entityType, balance}|{status, error}}
 */
function resolveSource(conn, sourceType, sourceId) {
  if (sourceType !== 'account' && sourceType !== 'liability') {
    return { status: 400, error: "source_type must be 'account' or 'liability'" };
  }
  const id = Number(sourceId);
  if (!Number.isInteger(id) || id <= 0) return { status: 400, error: 'source_id is required' };
  if (sourceType === 'account') {
    const source = conn.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
    if (!source) return { status: 404, error: 'Account not found' };
    return { source, statementType: 'bank', entityType: 'account', balance: source.balance };
  }
  const source = conn.prepare('SELECT * FROM liabilities WHERE id = ?').get(id);
  if (!source) return { status: 404, error: 'Liability not found' };
  if (source.type !== 'credit_card') {
    return { status: 400, error: 'Only credit_card liabilities can be linked to a card statement' };
  }
  return { source, statementType: 'credit_card', entityType: 'liability', balance: source.current_balance };
}

function loadRules(conn) {
  return new Map(conn.prepare('SELECT merchant_key, kind, category FROM merchant_rules').all()
    .map((r) => [r.merchant_key, { kind: r.kind, category: r.category }]));
}

/** Last-4 digits already known from saved statements, for card-payment and transfer rules. */
function knownLast4(conn, sourceType, sourceId) {
  const rows = conn.prepare(
    'SELECT DISTINCT statement_type, source_type, source_id, last4 FROM expense_statements WHERE last4 IS NOT NULL'
  ).all();
  return {
    knownCardLast4: rows.filter((r) => r.statement_type === 'credit_card').map((r) => r.last4),
    otherBankLast4: rows
      .filter((r) => r.statement_type === 'bank' && !(r.source_type === sourceType && r.source_id === sourceId))
      .map((r) => r.last4),
  };
}

function existingDedupeKeys(conn, keys) {
  const found = new Set();
  for (let i = 0; i < keys.length; i += 500) {
    const chunk = keys.slice(i, i + 500);
    const rows = conn.prepare(
      `SELECT dedupe_key FROM transactions WHERE dedupe_key IN (${chunk.map(() => '?').join(',')})`
    ).all(...chunk);
    rows.forEach((r) => found.add(r.dedupe_key));
  }
  return found;
}

/**
 * Applying a statement's closing balance is safe by default only when it cannot
 * overwrite a newer balance: the source is fresh (balance 0), has no history, or the
 * statement ends after the latest recorded value.
 */
function balanceUpdateIsSafe(conn, resolved, periodEnd) {
  if (!resolved.balance) return true;
  const row = conn.prepare(
    'SELECT MAX(recorded_at) AS latest FROM value_history WHERE entity_type = ? AND entity_id = ?'
  ).get(resolved.entityType, resolved.source.id);
  if (!row || !row.latest) return true;
  return !!periodEnd && periodEnd > row.latest;
}

// ─── POST /api/expenses/preview ───────────────────────────────────────────────

router.post('/preview', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const conn = db.getDb();
  const resolved = resolveSource(conn, req.body.source_type, req.body.source_id);
  if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
  const { statementType } = resolved;
  const sourceType = req.body.source_type;
  const sourceId = resolved.source.id;

  try {
    let parsed;
    if (isPdf(req.file)) {
      const pages = await pdfExtractor.extractPdfPages(req.file.buffer, req.body.password || '', { preserveLines: true });
      if (!pages.some((p) => p.trim())) {
        return res.status(422).json({ error: 'Could not extract text from PDF. The file may be scanned/image-only.' });
      }
      parsed = await parseTransactionsFromPages(pages, { statementType });
    } else if (isCsv(req.file)) {
      parsed = await parseTransactionsFromCsv(req.file.buffer, { statementType });
    } else {
      return res.status(422).json({ error: 'File must be a PDF or CSV statement' });
    }

    if (parsed.transactions.length === 0) {
      return res.status(422).json({
        error: 'No transactions could be found in this statement.',
        validation_notes: parsed.validation_notes,
      });
    }

    let transactions = applyPostProcessing(parsed.transactions, {
      statementType,
      rules: loadRules(conn),
      ...knownLast4(conn, sourceType, sourceId),
    });
    transactions = computeDedupeKeys(transactions, sourceType, sourceId);
    const existing = existingDedupeKeys(conn, transactions.map((t) => t.dedupe_key));
    transactions = transactions.map((t) => ({ ...t, duplicate: existing.has(t.dedupe_key) }));

    const validation_notes = [...parsed.validation_notes];
    const note = reconciliationNote(parsed.statement, parsed.transactions, statementType);
    if (note) validation_notes.push(note);

    const s = parsed.statement;
    res.json({
      statement: { ...s, statement_type: statementType, file_name: req.file.originalname || null },
      transactions,
      method: parsed.method,
      validation_notes,
      balance_update: {
        eligible: s.closing_balance != null,
        default_checked: s.closing_balance != null && balanceUpdateIsSafe(conn, resolved, s.period_end),
        entity_type: resolved.entityType,
        current: resolved.balance,
        proposed: s.closing_balance ?? null,
      },
    });
  } catch (err) {
    if (err.code === 'PASSWORD_REQUIRED') return res.status(422).json({ error: err.message, code: 'PASSWORD_REQUIRED' });
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Expense statement preview error:', err);
    res.status(500).json({ error: `Failed to parse statement: ${err.message}` });
  }
});

// ─── POST /api/expenses/commit ────────────────────────────────────────────────

router.post('/commit', (req, res) => {
  const conn = db.getDb();
  const {
    source_type: sourceType, source_id: rawSourceId, statement = {}, transactions,
    update_balance: updateBalance = false, force_balance: forceBalance = false,
  } = req.body || {};
  const resolved = resolveSource(conn, sourceType, rawSourceId);
  if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
  const sourceId = resolved.source.id;

  if (!Array.isArray(transactions) || transactions.length === 0) {
    return res.status(400).json({ error: 'transactions must be a non-empty array' });
  }
  const clean = [];
  for (const [i, t] of transactions.entries()) {
    const date = parseTxnDate(t && t.date);
    const amount = Number(t && t.amount);
    const description = String((t && t.description) || '').trim();
    if (!date || !(amount > 0) || !description || !['debit', 'credit'].includes(t.direction) || !KINDS.includes(t.kind)) {
      return res.status(400).json({
        error: `Transaction ${i + 1} is invalid: it needs a date, description, amount above 0, direction and a valid kind`,
      });
    }
    clean.push({
      date, description, amount, direction: t.direction, kind: t.kind,
      merchant: t.merchant || null,
      merchant_key: merchantKey(description),
      category: EXCLUDED_KINDS.includes(t.kind) ? null : (t.category || null),
      needs_review: t.needs_review ? 1 : 0,
      edited: !!t.edited,
      remember: t.remember !== false,
    });
  }
  const keyed = computeDedupeKeys(clean, sourceType, sourceId);
  const dates = keyed.map((t) => t.date).sort();
  const periodStart = parseTxnDate(statement.period_start) || dates[0];
  const periodEnd = parseTxnDate(statement.period_end) || dates[dates.length - 1];
  const closing = statement.closing_balance == null || statement.closing_balance === ''
    ? null : Number(statement.closing_balance);

  if (updateBalance) {
    if (closing == null || !Number.isFinite(closing)) {
      return res.status(400).json({ error: 'The statement has no closing balance to apply' });
    }
    if (!forceBalance && !balanceUpdateIsSafe(conn, resolved, periodEnd)) {
      return res.status(409).json({
        error: 'This statement ends before the balance was last updated, so its closing balance would overwrite a newer value.',
        code: 'STALE_BALANCE',
      });
    }
  }

  const result = conn.transaction(() => {
    let statementId = conn.prepare(
      `INSERT INTO expense_statements
         (source_type, source_id, statement_type, file_name, last4, period_start, period_end,
          opening_balance, closing_balance, parse_method)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      sourceType, sourceId, resolved.statementType,
      statement.file_name ? String(statement.file_name) : null,
      /^\d{4}$/.test(String(statement.last4 || '')) ? String(statement.last4) : null,
      periodStart, periodEnd,
      statement.opening_balance == null || statement.opening_balance === '' ? null : Number(statement.opening_balance),
      closing,
      ['ai', 'pattern'].includes(statement.parse_method) ? statement.parse_method : null,
    ).lastInsertRowid;

    const insert = conn.prepare(
      `INSERT OR IGNORE INTO transactions
         (statement_id, source_type, source_id, txn_date, description, merchant, merchant_key, amount,
          direction, kind, category, needs_review, kind_locked, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const upsertRule = conn.prepare(UPSERT_RULE_SQL);
    let inserted = 0;
    let duplicates = 0;
    let rulesLearned = 0;
    for (const t of keyed) {
      const r = insert.run(
        statementId, sourceType, sourceId, t.date, t.description, t.merchant, t.merchant_key, t.amount,
        t.direction, t.kind, t.category, t.edited ? 0 : t.needs_review, t.edited ? 1 : 0, t.dedupe_key,
      );
      if (r.changes) inserted++;
      else duplicates++;
      if (t.edited && t.remember && t.merchant_key) {
        upsertRule.run(t.merchant_key, t.kind, t.category);
        rulesLearned++;
      }
    }
    // A re-upload where every row already exists leaves no empty statement behind.
    if (inserted === 0) {
      conn.prepare('DELETE FROM expense_statements WHERE id = ?').run(statementId);
      statementId = null;
    }

    const matches = runMatcher(conn, {
      from: shiftDate(dates[0], -MATCH_WINDOW_DAYS),
      to: shiftDate(dates[dates.length - 1], MATCH_WINDOW_DAYS),
    });

    let balanceUpdated = false;
    if (updateBalance) {
      if (resolved.entityType === 'account') {
        conn.prepare(`UPDATE accounts SET balance = ?, updated_at = datetime('now') WHERE id = ?`).run(closing, sourceId);
      } else {
        conn.prepare(`UPDATE liabilities SET current_balance = ?, updated_at = datetime('now') WHERE id = ?`).run(closing, sourceId);
      }
      conn.prepare(
        `INSERT INTO value_history (entity_type, entity_id, value, recorded_at, notes)
         VALUES (?, ?, ?, ?, 'expense statement import')`
      ).run(resolved.entityType, sourceId, closing, periodEnd || today());
      balanceUpdated = true;
    }

    return {
      statement_id: statementId == null ? null : Number(statementId),
      inserted, duplicates, rules_learned: rulesLearned, matches, balance_updated: balanceUpdated,
    };
  })();

  res.status(201).json(result);
});

module.exports = router;
