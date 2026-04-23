/**
 * importService.js – CSV / JSON / PDF import for the local SQLite path.
 *
 * On Android (Capacitor native) there is no backend server, so:
 *   – CSV is parsed client-side with PapaParse.
 *   – JSON records are inserted directly.
 *   – PDF text is extracted with pdfjs-dist (see pdfService.js) then parsed
 *     by the client-side statementParser (see statementParser.js).
 */

import Papa from 'papaparse';
import { query, run } from './dbService';
import { parseStatement } from '../hooks/statementParser';
import { extractPdfText } from '../hooks/pdfService';

const today = () => new Date().toISOString().slice(0, 10);

// ─── Duplicate detection (mirrors importRoutes.js) ───────────────────────────

async function isDuplicateRecord(importType, row) {
  const name = String(row.name || '');
  if (importType === 'accounts') {
    const rows = await query(
      `SELECT id FROM accounts WHERE lower(name)=lower(?) AND lower(coalesce(institution,''))=lower(coalesce(?,''))`,
      [name, row.institution ? String(row.institution) : null]
    );
    return rows.length > 0;
  }
  if (importType === 'assets') {
    const rows = await query(`SELECT id FROM assets WHERE lower(name)=lower(?)`, [name]);
    return rows.length > 0;
  }
  if (importType === 'liabilities') {
    const rows = await query(
      `SELECT id FROM liabilities WHERE lower(name)=lower(?) AND lower(coalesce(lender,''))=lower(coalesce(?,''))`,
      [name, row.lender ? String(row.lender) : null]
    );
    return rows.length > 0;
  }
  if (importType === 'insurance') {
    const rows = await query(
      `SELECT id FROM insurance_plans WHERE lower(name)=lower(?) AND lower(coalesce(provider,''))=lower(coalesce(?,''))`,
      [name, row.provider ? String(row.provider) : null]
    );
    return rows.length > 0;
  }
  return false;
}

// ─── Single-row insert (mirrors CSV importRow logic) ─────────────────────────

async function insertRow(importType, row) {
  if (importType === 'accounts') {
    const { name, institution, type = 'other', currency = 'USD', balance = 0 } = row;
    if (!name) throw new Error('name is required');
    await run(
      `INSERT INTO accounts (name, institution, type, currency, balance) VALUES (?, ?, ?, ?, ?)`,
      [String(name), institution ? String(institution) : null, String(type), String(currency), Number(balance)]
    );
  } else if (importType === 'assets') {
    const { name, category = 'other', acquisition_date, acquisition_cost, current_value = 0 } = row;
    if (!name) throw new Error('name is required');
    await run(
      `INSERT INTO assets (name, category, acquisition_date, acquisition_cost, current_value) VALUES (?, ?, ?, ?, ?)`,
      [String(name), String(category), acquisition_date ? String(acquisition_date) : null,
       acquisition_cost != null ? Number(acquisition_cost) : null, Number(current_value)]
    );
  } else if (importType === 'liabilities') {
    const { name, lender, type = 'other', original_principal, current_balance = 0, interest_rate, minimum_payment } = row;
    if (!name) throw new Error('name is required');
    await run(
      `INSERT INTO liabilities (name, lender, type, original_principal, current_balance, interest_rate, minimum_payment) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [String(name), lender ? String(lender) : null, String(type),
       original_principal != null ? Number(original_principal) : null, Number(current_balance),
       interest_rate != null ? Number(interest_rate) : null,
       minimum_payment != null ? Number(minimum_payment) : null]
    );
  } else if (importType === 'insurance') {
    const { name, provider, type = 'other', policy_number, premium_amount, premium_frequency = 'monthly', coverage_amount, start_date, end_date, renewal_date, notes } = row;
    if (!name) throw new Error('name is required');
    await run(
      `INSERT INTO insurance_plans (name, provider, type, policy_number, premium_amount, premium_frequency, coverage_amount, start_date, end_date, renewal_date, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [String(name), provider ? String(provider) : null, String(type), policy_number ? String(policy_number) : null,
       premium_amount != null ? Number(premium_amount) : null, String(premium_frequency),
       coverage_amount != null ? Number(coverage_amount) : null,
       start_date ? String(start_date) : null, end_date ? String(end_date) : null,
       renewal_date ? String(renewal_date) : null, notes ? String(notes) : null]
    );
  } else if (importType === 'sip') {
    const { name, symbol, account_id, amount, units, nav, installment_date, notes } = row;
    if (!name) throw new Error('name is required');
    if (amount == null || Number(amount) <= 0) throw new Error('amount must be a positive number');
    await run(
      `INSERT INTO sip_installments (name, symbol, account_id, amount, units, nav, installment_date, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [String(name), symbol ? String(symbol) : null, account_id ? Number(account_id) : null,
       Number(amount), units != null ? Number(units) : null, nav != null ? Number(nav) : null,
       installment_date ? String(installment_date) : today(), notes ? String(notes) : null]
    );
  } else {
    throw new Error(`Unknown import type: ${importType}`);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Import an array of pre-parsed records directly into SQLite.
 * Skips duplicates (for everything except SIP which allows duplicates).
 */
export async function importRecords(importType, records) {
  const results = { imported: 0, skipped: 0, errors: [] };
  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    try {
      const isDup = importType !== 'sip' && await isDuplicateRecord(importType, row);
      if (isDup) { results.skipped++; continue; }
      await insertRow(importType, row);
      results.imported++;
    } catch (err) {
      results.skipped++;
      results.errors.push({ row: i + 1, message: err.message });
    }
  }
  return results;
}

/**
 * Parse a CSV File object and import its rows.
 */
export async function importCsv(importType, file) {
  const text = await file.text();
  const { data, errors } = Papa.parse(text, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: true,
    transformHeader: (h) => h.toLowerCase().replace(/\s+/g, '_'),
  });
  if (errors.length && !data.length) {
    throw new Error(`CSV parse error: ${errors[0].message}`);
  }
  return importRecords(importType, data);
}

/**
 * Preview a PDF: extract text then parse with AI/pattern matching.
 * Returns the same shape as the backend /api/import/pdf/preview.
 */
export async function previewPdf(file, password) {
  const buf = await file.arrayBuffer();
  const text = await extractPdfText(buf, password);
  if (!text.trim()) throw new Error('Could not extract text from PDF. The file may be scanned/image-only.');
  return parseStatement(text, {});
}

/**
 * Import a PDF: optionally re-use previewed records, otherwise re-parse.
 * @param {object} [aiOptions] – { apiKey, apiUrl, model } passed to parseStatement
 */
export async function importPdf(file, password, importType, previewedRecords, aiOptions = {}) {
  let parsed;
  if (previewedRecords) {
    if (!importType) throw new Error('importType is required when previewedRecords is provided');
    parsed = { import_type: importType, records: previewedRecords, method: 'preview' };
  } else {
    const buf = await file.arrayBuffer();
    const text = await extractPdfText(buf, password);
    if (!text.trim()) throw new Error('Could not extract text from PDF.');
    parsed = await parseStatement(text, aiOptions);
  }
  const resolvedType = importType || parsed.import_type;
  const result = await importRecords(resolvedType, parsed.records);
  return { ...result, method: parsed.method };
}

/**
 * Parse raw text and return a preview (same shape as backend /api/import/text).
 */
export async function parseText(text, importType) {
  const result = await parseStatement(text, {});
  return result;
}
