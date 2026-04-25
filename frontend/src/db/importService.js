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
import { parseStatement, mapCsvColumnsWithAI } from '../hooks/statementParser';
import { extractPdfText } from '../hooks/pdfService';
import { getSettings } from './settingsService';

const today = () => new Date().toISOString().slice(0, 10);

async function readDefaultCurrency() {
  try {
    const cfg = await getSettings();
    const raw = cfg.defaultCurrency;
    if (raw != null) return String(raw).replace(/^"|"$/g, '');
  } catch (_) { /* ignore */ }
  return null;
}

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
      `SELECT id FROM insurance_plans WHERE lower(name)=lower(?) AND lower(coalesce(provider,''))=lower(coalesce(?,'')) AND lower(coalesce(insured_name,''))=lower(coalesce(?,''))`,
      [name, row.provider ? String(row.provider) : null, row.insured_name ? String(row.insured_name) : null]
    );
    return rows.length > 0;
  }
  return false;
}

/**
 * Check which records (by index) are duplicates in the local SQLite DB.
 * Returns { duplicates: [index, ...] }.  SIP installments are never flagged.
 */
export async function checkDuplicates(importType, records) {
  const duplicates = [];
  for (let i = 0; i < records.length; i++) {
    if (importType !== 'sip' && await isDuplicateRecord(importType, records[i])) {
      duplicates.push(i);
    }
  }
  return { duplicates };
}

// ─── Single-row insert (mirrors CSV importRow logic) ─────────────────────────

async function insertRow(importType, row, defaultCurrency = null) {
  if (importType === 'accounts') {
    const { name, institution, type = 'other', currency = defaultCurrency, balance = 0 } = row;
    if (!name) throw new Error('name is required');
    await run(
      `INSERT INTO accounts (name, institution, type, currency, balance) VALUES (?, ?, ?, COALESCE(?, 'USD'), ?)`,
      [String(name), institution ? String(institution) : null, String(type), currency || null, Number(balance)]
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
    const { name, provider, type = 'other', policy_number, premium_amount, premium_frequency = 'monthly', coverage_amount, start_date, end_date, renewal_date, notes, terms, covered_conditions, insured_name } = row;
    if (!name) throw new Error('name is required');
    const covJson = covered_conditions != null
      ? JSON.stringify(Array.isArray(covered_conditions) ? covered_conditions : [])
      : null;
    await run(
      `INSERT INTO insurance_plans (name, provider, type, policy_number, premium_amount, premium_frequency, coverage_amount, start_date, end_date, renewal_date, notes, terms, covered_conditions, insured_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [String(name), provider ? String(provider) : null, String(type), policy_number ? String(policy_number) : null,
       premium_amount != null ? Number(premium_amount) : null, String(premium_frequency),
       coverage_amount != null ? Number(coverage_amount) : null,
       start_date ? String(start_date) : null, end_date ? String(end_date) : null,
       renewal_date ? String(renewal_date) : null, notes ? String(notes) : null,
       terms ? String(terms) : null, covJson,
       insured_name ? String(insured_name) : null]
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
 * Records with _forceImport: true bypass the duplicate check.
 */
export async function importRecords(importType, records) {
  const defaultCurrency = await readDefaultCurrency();
  const results = { imported: 0, skipped: 0, duplicates: 0, errors: [] };
  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    try {
      const isDup = importType !== 'sip' && !row._forceImport && await isDuplicateRecord(importType, row);
      if (isDup) { results.skipped++; results.duplicates++; continue; }
      await insertRow(importType, row, defaultCurrency);
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
 * Preview a CSV file using AI to map arbitrary column headers to the target schema.
 * Falls back to basic key normalization when AI is unavailable.
 *
 * @param {string} importType  – 'accounts'|'assets'|'liabilities'|'insurance'|'sip'
 * @param {File}   file        – CSV File object
 * @param {object} [aiOptions] – { apiKey, apiUrl, model } from aiSettings.js
 * @returns {Promise<{ import_type, records, method, validation_notes }>}
 */
export async function previewCsv(importType, file, aiOptions = {}) {
  const text = await file.text();
  const { data, errors } = Papa.parse(text, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: true,
  });
  if (errors.length && !data.length) {
    throw new Error(`CSV parse error: ${errors[0].message}`);
  }
  if (data.length === 0) {
    throw new Error('CSV file is empty or has no data rows');
  }

  const headers = Object.keys(data[0]);
  const sampleRows = data.slice(0, 3);

  let mappedRecords;
  let method;
  let validationNotes = [];

  try {
    const aiResult = await mapCsvColumnsWithAI(headers, sampleRows, importType, aiOptions);
    if (aiResult && aiResult.column_mapping) {
      mappedRecords = data.map((row) => {
        const mapped = {};
        for (const [csvCol, targetField] of Object.entries(aiResult.column_mapping)) {
          if (targetField && row[csvCol] !== undefined && row[csvCol] !== null && row[csvCol] !== '') {
            mapped[targetField] = row[csvCol];
          }
        }
        return mapped;
      });
      method = 'ai';
      validationNotes = aiResult.mapping_notes || [];
    } else {
      throw new Error('AI unavailable');
    }
  } catch (aiErr) {
    // AI mapping failed or unavailable — fall back to basic key normalization
    if (aiErr.message !== 'AI unavailable') {
      console.error('CSV AI column mapping failed, falling back to key normalization:', aiErr.message);
    }
    mappedRecords = data.map((row) => {
      const out = {};
      for (const [k, v] of Object.entries(row)) {
        out[k.toLowerCase().replace(/\s+/g, '_')] = v;
      }
      return out;
    });
    method = 'pattern';
  }

  return { import_type: importType, records: mappedRecords, method, validation_notes: validationNotes };
}

/**
 * Preview a PDF: extract text then parse with AI/pattern matching.
 * Returns the same shape as the backend /api/import/pdf/preview.
 * @param {object} [aiOptions] – { apiKey, apiUrl, model } passed to parseStatement
 */
export async function previewPdf(file, password, aiOptions = {}) {
  const defaultCurrency = await readDefaultCurrency();
  const buf = await file.arrayBuffer();
  const text = await extractPdfText(buf, password);
  if (!text.trim()) throw new Error('Could not extract text from PDF. The file may be scanned/image-only.');
  return parseStatement(text, { ...aiOptions, defaultCurrency });
}

/**
 * Import a PDF: optionally re-use previewed records, otherwise re-parse.
 * @param {object} [aiOptions] – { apiKey, apiUrl, model } passed to parseStatement
 */
export async function importPdf(file, password, importType, previewedRecords, aiOptions = {}) {
  const defaultCurrency = await readDefaultCurrency();
  let parsed;
  if (previewedRecords) {
    if (!importType) throw new Error('importType is required when previewedRecords is provided');
    parsed = { import_type: importType, records: previewedRecords, method: 'preview' };
  } else {
    const buf = await file.arrayBuffer();
    const text = await extractPdfText(buf, password);
    if (!text.trim()) throw new Error('Could not extract text from PDF.');
    parsed = await parseStatement(text, { ...aiOptions, defaultCurrency });
  }
  const resolvedType = importType || parsed.import_type;
  const result = await importRecords(resolvedType, parsed.records);
  return { ...result, method: parsed.method };
}

/**
 * Parse raw text and return a preview (same shape as backend /api/import/text).
 */
export async function parseText(text, importType) {
  const defaultCurrency = await readDefaultCurrency();
  const result = await parseStatement(text, { defaultCurrency });
  return result;
}
