const express = require('express');
const router = express.Router();
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const db = require('../db/database');
const { extractPdfText } = require('../utils/pdfExtractor');
const { parseStatement, mapCsvColumnsWithAI } = require('../utils/statementParser');

class DuplicateError extends Error {}

function getDefaultCurrency(conn) {
  try {
    const row = conn.prepare('SELECT value FROM settings WHERE key = ?').get('defaultCurrency');
    if (row) return JSON.parse(row.value);
  } catch (_) { /* ignore */ }
  return null;
}

/**
 * Returns true when a row with the same natural key already exists in the DB.
 * @param {string} importType - 'accounts'|'assets'|'liabilities'|'insurance'
 * @param {object} row - record with at least { name, institution?, lender?, provider? }
 */
function isDuplicateRecord(conn, importType, row) {
  const name = String(row.name || '');
  if (importType === 'accounts') {
    return !!conn.prepare(
      `SELECT id FROM accounts WHERE lower(name) = lower(?) AND lower(coalesce(institution,'')) = lower(coalesce(?,''))`
    ).get(name, row.institution ? String(row.institution) : null);
  }
  if (importType === 'assets') {
    return !!conn.prepare(`SELECT id FROM assets WHERE lower(name) = lower(?)`).get(name);
  }
  if (importType === 'liabilities') {
    return !!conn.prepare(
      `SELECT id FROM liabilities WHERE lower(name) = lower(?) AND lower(coalesce(lender,'')) = lower(coalesce(?,''))`
    ).get(name, row.lender ? String(row.lender) : null);
  }
  if (importType === 'insurance') {
    return !!conn.prepare(
      `SELECT id FROM insurance_plans WHERE lower(name) = lower(?) AND lower(coalesce(provider,'')) = lower(coalesce(?,'')) AND lower(coalesce(insured_name,'')) = lower(coalesce(?,''))`
    ).get(name, row.provider ? String(row.provider) : null, row.insured_name ? String(row.insured_name) : null);
  }
  return false;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB (PDFs can be larger than CSVs)
});

/**
 * POST /api/import/csv
 * Expected CSV columns (case-insensitive):
 *   For accounts balance import:
 *     name, institution, type, currency, balance
 *   For assets:
 *     name, category, acquisition_date, acquisition_cost, current_value
 *   For liabilities:
 *     name, lender, type, original_principal, current_balance, interest_rate, minimum_payment
 *
 * The import_type query param determines which table to import into:
 *   ?import_type=accounts  (default)
 *   ?import_type=assets
 *   ?import_type=liabilities
 */
const VALID_IMPORT_TYPES = ['accounts', 'assets', 'liabilities', 'insurance'];

router.post('/csv', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const importType = req.query.import_type || 'accounts';
  if (!VALID_IMPORT_TYPES.includes(importType)) {
    return res.status(400).json({ error: `import_type must be one of: ${VALID_IMPORT_TYPES.join(', ')}` });
  }

  let records;
  try {
    records = parse(req.file.buffer, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      cast: true,
    });
  } catch (err) {
    return res.status(422).json({ error: `CSV parse error: ${err.message}` });
  }

  if (records.length === 0) {
    return res.status(422).json({ error: 'CSV file is empty or has no data rows' });
  }

  const conn = db.getDb();
  const defaultCurrency = getDefaultCurrency(conn);
  const results = { imported: 0, skipped: 0, duplicates: 0, errors: [] };

  const normalizeKeys = (obj) => {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k.toLowerCase().replace(/\s+/g, '_')] = v;
    }
    return out;
  };

  const isDuplicate = (row) => isDuplicateRecord(conn, importType, row);

  const importRow = conn.transaction((record) => {
    const row = normalizeKeys(record);

    if (isDuplicate(row)) throw new DuplicateError('Duplicate entry skipped');

    if (importType === 'accounts') {
      const { name, institution, type = 'other', currency = defaultCurrency, balance = 0 } = row;
      if (!name) throw new Error('name is required');
      conn.prepare(
        `INSERT INTO accounts (name, institution, type, currency, balance)
         VALUES (?, ?, ?, COALESCE(?, 'USD'), ?)`
      ).run(String(name), institution ? String(institution) : null, String(type), currency || null, Number(balance));

    } else if (importType === 'assets') {
      const { name, category = 'other', acquisition_date, acquisition_cost, current_value = 0 } = row;
      if (!name) throw new Error('name is required');
      conn.prepare(
        `INSERT INTO assets (name, category, acquisition_date, acquisition_cost, current_value)
         VALUES (?, ?, ?, ?, ?)`
      ).run(
        String(name), String(category),
        acquisition_date ? String(acquisition_date) : null,
        acquisition_cost != null ? Number(acquisition_cost) : null,
        Number(current_value)
      );

    } else if (importType === 'liabilities') {
      const { name, lender, type = 'other', original_principal, current_balance = 0, interest_rate, minimum_payment } = row;
      if (!name) throw new Error('name is required');
      conn.prepare(
        `INSERT INTO liabilities (name, lender, type, original_principal, current_balance, interest_rate, minimum_payment)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        String(name), lender ? String(lender) : null, String(type),
        original_principal != null ? Number(original_principal) : null,
        Number(current_balance),
        interest_rate != null ? Number(interest_rate) : null,
        minimum_payment != null ? Number(minimum_payment) : null
      );

    } else if (importType === 'insurance') {
      const { name, provider, type = 'other', policy_number, premium_amount, premium_frequency = 'monthly', coverage_amount, start_date, end_date, renewal_date, notes, terms, covered_conditions, insured_name } = row;
      if (!name) throw new Error('name is required');
      const covJson = covered_conditions != null
        ? JSON.stringify(Array.isArray(covered_conditions) ? covered_conditions : [])
        : null;
      conn.prepare(
        `INSERT INTO insurance_plans (name, provider, type, policy_number, premium_amount, premium_frequency, coverage_amount, start_date, end_date, renewal_date, notes, terms, covered_conditions, insured_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        String(name), provider ? String(provider) : null, String(type),
        policy_number ? String(policy_number) : null,
        premium_amount != null ? Number(premium_amount) : null,
        String(premium_frequency),
        coverage_amount != null ? Number(coverage_amount) : null,
        start_date ? String(start_date) : null,
        end_date ? String(end_date) : null,
        renewal_date ? String(renewal_date) : null,
        notes ? String(notes) : null,
        terms ? String(terms) : null,
        covJson,
        insured_name ? String(insured_name) : null
      );

    }
  });

  for (let i = 0; i < records.length; i++) {
    try {
      importRow(records[i]);
      results.imported++;
    } catch (err) {
      results.skipped++;
      if (err instanceof DuplicateError) {
        results.duplicates++;
      } else {
        results.errors.push({ row: i + 2, message: err.message });
      }
    }
  }

  res.json(results);
});

/**
 * POST /api/import/csv/preview
 * Upload a CSV file, use AI to intelligently map column headers to target schema fields,
 * and return a preview of the mapped records WITHOUT writing to the database.
 *
 * Query params: ?import_type=accounts|assets|liabilities|insurance  (default: accounts)
 *
 * When AI is unavailable, falls back to basic lowercase+underscore key normalization.
 */
router.post('/csv/preview', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const importType = req.query.import_type || 'accounts';
  if (!VALID_IMPORT_TYPES.includes(importType)) {
    return res.status(400).json({ error: `import_type must be one of: ${VALID_IMPORT_TYPES.join(', ')}` });
  }

  let records;
  try {
    records = parse(req.file.buffer, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      cast: true,
    });
  } catch (err) {
    return res.status(422).json({ error: `CSV parse error: ${err.message}` });
  }

  if (records.length === 0) {
    return res.status(422).json({ error: 'CSV file is empty or has no data rows' });
  }

  const headers = Object.keys(records[0]);
  const sampleRows = records.slice(0, 3);

  let mappedRecords;
  let method;
  let validationNotes = [];

  try {
    const aiResult = await mapCsvColumnsWithAI(headers, sampleRows, importType);
    if (aiResult && aiResult.column_mapping) {
      // Apply the AI column mapping to every row
      mappedRecords = records.map((row) => {
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
    // AI mapping failed or unavailable — fall back to basic key normalization (same as /csv route)
    if (aiErr.message !== 'AI unavailable') {
      console.error('CSV AI column mapping failed, falling back to key normalization:', aiErr.message);
    }
    mappedRecords = records.map((row) => {
      const out = {};
      for (const [k, v] of Object.entries(row)) {
        out[k.toLowerCase().replace(/\s+/g, '_')] = v;
      }
      return out;
    });
    method = 'pattern';
  }

  res.json({ import_type: importType, records: mappedRecords, method, validation_notes: validationNotes });
});


router.post('/json', express.json({ limit: '10mb' }), (req, res) => {
  const { import_type: importType = 'accounts', records } = req.body || {};

  if (!Array.isArray(records) || records.length === 0) {
    return res.status(400).json({ error: 'records must be a non-empty array' });
  }

  if (!VALID_IMPORT_TYPES.includes(importType)) {
    return res.status(400).json({ error: `import_type must be one of: ${VALID_IMPORT_TYPES.join(', ')}` });
  }

  const conn = db.getDb();
  const defaultCurrency = getDefaultCurrency(conn);
  const results = { imported: 0, skipped: 0, duplicates: 0, errors: [] };

  const isDuplicateJson = (row) => isDuplicateRecord(conn, importType, row);

  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    try {
      if (!row._forceImport && isDuplicateJson(row)) { results.skipped++; results.duplicates++; continue; }

      if (importType === 'accounts') {
        const { name, institution, type = 'other', currency = defaultCurrency, balance = 0 } = row;
        if (!name) throw new Error('name is required');
        conn.prepare(
          `INSERT INTO accounts (name, institution, type, currency, balance) VALUES (?, ?, ?, COALESCE(?, 'USD'), ?)`
        ).run(String(name), institution ? String(institution) : null, String(type), currency || null, Number(balance));

      } else if (importType === 'assets') {
        const { name, category = 'other', acquisition_date, acquisition_cost, current_value = 0 } = row;
        if (!name) throw new Error('name is required');
        conn.prepare(
          `INSERT INTO assets (name, category, acquisition_date, acquisition_cost, current_value) VALUES (?, ?, ?, ?, ?)`
        ).run(
          String(name), String(category),
          acquisition_date ? String(acquisition_date) : null,
          acquisition_cost != null ? Number(acquisition_cost) : null,
          Number(current_value)
        );

      } else if (importType === 'liabilities') {
        const { name, lender, type = 'other', original_principal, current_balance = 0, interest_rate, minimum_payment } = row;
        if (!name) throw new Error('name is required');
        conn.prepare(
          `INSERT INTO liabilities (name, lender, type, original_principal, current_balance, interest_rate, minimum_payment) VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(
          String(name), lender ? String(lender) : null, String(type),
          original_principal != null ? Number(original_principal) : null,
          Number(current_balance),
          interest_rate != null ? Number(interest_rate) : null,
          minimum_payment != null ? Number(minimum_payment) : null
        );

      } else if (importType === 'insurance') {
        const { name, provider, type = 'other', policy_number, premium_amount, premium_frequency = 'monthly', coverage_amount, start_date, end_date, renewal_date, notes, terms, covered_conditions, insured_name } = row;
        if (!name) throw new Error('name is required');
        const covJson = covered_conditions != null
          ? JSON.stringify(Array.isArray(covered_conditions) ? covered_conditions : [])
          : null;
        conn.prepare(
          `INSERT INTO insurance_plans (name, provider, type, policy_number, premium_amount, premium_frequency, coverage_amount, start_date, end_date, renewal_date, notes, terms, covered_conditions, insured_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          String(name), provider ? String(provider) : null, String(type),
          policy_number ? String(policy_number) : null,
          premium_amount != null ? Number(premium_amount) : null,
          String(premium_frequency),
          coverage_amount != null ? Number(coverage_amount) : null,
          start_date ? String(start_date) : null,
          end_date ? String(end_date) : null,
          renewal_date ? String(renewal_date) : null,
          notes ? String(notes) : null,
          terms ? String(terms) : null,
          covJson,
          insured_name ? String(insured_name) : null
        );
      }
      results.imported++;
    } catch (err) {
      results.skipped++;
      results.errors.push({ row: i + 1, message: err.message });
    }
  }

  res.json(results);
});


/**
 * POST /api/import/check-duplicates
 * Body: { import_type, records }
 * Returns: { duplicates: [index, ...] } – indices of records that already exist in the DB.
 */
router.post('/check-duplicates', express.json({ limit: '1mb' }), (req, res) => {
  const { import_type: importType, records } = req.body || {};
  if (!VALID_IMPORT_TYPES.includes(importType)) {
    return res.status(400).json({ error: `import_type must be one of: ${VALID_IMPORT_TYPES.join(', ')}` });
  }
  if (!Array.isArray(records)) {
    return res.status(400).json({ error: 'records must be an array' });
  }
  const conn = db.getDb();
  const duplicates = [];
  for (let i = 0; i < records.length; i++) {
    if (isDuplicateRecord(conn, importType, records[i])) {
      duplicates.push(i);
    }
  }
  res.json({ duplicates });
});

/**
 * Returns an error response if the uploaded file is not a PDF, otherwise null.
 * Checks both the MIME type (when provided by the browser) and the file extension.
 */
function validatePdfFile(req, res) {
  if (!req.file) {
    res.status(400).json({ error: 'No file uploaded' });
    return false;
  }
  if (
    req.file.mimetype &&
    !req.file.mimetype.includes('pdf') &&
    !req.file.originalname?.toLowerCase().endsWith('.pdf')
  ) {
    res.status(422).json({ error: 'File must be a PDF' });
    return false;
  }
  return true;
}

/**
 * POST /api/import/pdf/preview
 * Upload a PDF statement (optionally password-protected), extract text,
 * and run the smart parser + optional AI parser.  Returns a preview of
 * what would be imported WITHOUT writing to the database.
 *
 * Form fields:
 *   file        – PDF file (required)
 *   password    – PDF password (optional)
 */
router.post('/pdf/preview', upload.single('file'), async (req, res) => {
  if (!validatePdfFile(req, res)) return;

  try {
    const text = await extractPdfText(req.file.buffer, req.body.password || '');
    if (!text.trim()) {
      return res.status(422).json({ error: 'Could not extract text from PDF. The file may be scanned/image-only.' });
    }

    const conn = db.getDb();
    const result = await parseStatement(text, { defaultCurrency: getDefaultCurrency(conn) });
    res.json(result);
  } catch (err) {
    if (err.code === 'PASSWORD_REQUIRED') {
      return res.status(422).json({ error: err.message, code: 'PASSWORD_REQUIRED' });
    }
    console.error('PDF preview error:', err);
    res.status(500).json({ error: `Failed to parse PDF: ${err.message}` });
  }
});

/**
 * POST /api/import/pdf
 * Parse and immediately import a PDF statement into the database.
 * Accepts same fields as /pdf/preview, plus:
 *   import_type       – optional override ('accounts'|'assets'|'liabilities'|'insurance')
 *   previewed_records – optional JSON string of pre-parsed records from /pdf/preview.
 *                       When provided the PDF is not re-parsed, preventing drift between
 *                       what the user reviewed and what is actually written to the DB.
 */
router.post('/pdf', upload.single('file'), async (req, res) => {
  if (!validatePdfFile(req, res)) return;

  try {
    let parsed;

    // If the client supplies pre-parsed records (from the /pdf/preview step) use them
    // directly so the user always gets exactly what they reviewed imported into the DB.
    if (req.body.previewed_records) {
      if (!req.body.import_type) {
        return res.status(400).json({ error: 'import_type is required when previewed_records is provided' });
      }
      let previewedRecords;
      try {
        previewedRecords = JSON.parse(req.body.previewed_records);
      } catch {
        return res.status(400).json({ error: 'previewed_records must be a valid JSON array string' });
      }
      if (!Array.isArray(previewedRecords)) {
        return res.status(400).json({ error: 'previewed_records must be a JSON array' });
      }
      parsed = {
        import_type: req.body.import_type,
        records: previewedRecords,
        method: 'preview',
      };
    } else {
      // Re-parse from the PDF (legacy path / direct API calls without a prior preview)
      const text = await extractPdfText(req.file.buffer, req.body.password || '');
      if (!text.trim()) {
        return res.status(422).json({ error: 'Could not extract text from PDF.' });
      }
      const conn2 = db.getDb();
      parsed = await parseStatement(text, { defaultCurrency: getDefaultCurrency(conn2) });
    }

    // Allow caller to override the detected import type
    const importType = req.body.import_type || parsed.import_type;
    if (!VALID_IMPORT_TYPES.includes(importType)) {
      return res.status(400).json({ error: `import_type must be one of: ${VALID_IMPORT_TYPES.join(', ')}` });
    }

    const conn = db.getDb();
    const defaultCurrency = getDefaultCurrency(conn);
    const results = { imported: 0, skipped: 0, duplicates: 0, errors: [], method: parsed.method };

    const isDuplicatePdf = (row) => isDuplicateRecord(conn, importType, row);

    for (let i = 0; i < parsed.records.length; i++) {
      const row = parsed.records[i];
      try {
        if (!row._forceImport && isDuplicatePdf(row)) { results.skipped++; results.duplicates++; continue; }

        if (importType === 'accounts') {
          const { name, institution, type = 'other', currency = defaultCurrency, balance = 0 } = row;
          if (!name) throw new Error('name is required');
          conn.prepare(
            `INSERT INTO accounts (name, institution, type, currency, balance) VALUES (?, ?, ?, COALESCE(?, 'USD'), ?)`
          ).run(String(name), institution ? String(institution) : null, String(type), currency || null, Number(balance));
        } else if (importType === 'assets') {
          const { name, category = 'other', acquisition_date, acquisition_cost, current_value = 0 } = row;
          if (!name) throw new Error('name is required');
          conn.prepare(
            `INSERT INTO assets (name, category, acquisition_date, acquisition_cost, current_value) VALUES (?, ?, ?, ?, ?)`
          ).run(
            String(name), String(category),
            acquisition_date ? String(acquisition_date) : null,
            acquisition_cost != null ? Number(acquisition_cost) : null,
            Number(current_value)
          );
        } else if (importType === 'liabilities') {
          const { name, lender, type = 'other', original_principal, current_balance = 0, interest_rate, minimum_payment } = row;
          if (!name) throw new Error('name is required');
          conn.prepare(
            `INSERT INTO liabilities (name, lender, type, original_principal, current_balance, interest_rate, minimum_payment) VALUES (?, ?, ?, ?, ?, ?, ?)`
          ).run(
            String(name), lender ? String(lender) : null, String(type),
            original_principal != null ? Number(original_principal) : null,
            Number(current_balance),
            interest_rate != null ? Number(interest_rate) : null,
            minimum_payment != null ? Number(minimum_payment) : null
          );
        } else if (importType === 'insurance') {
          const { name, provider, type = 'other', policy_number, premium_amount, premium_frequency = 'monthly', coverage_amount, start_date, end_date, renewal_date, notes, terms, covered_conditions, insured_name } = row;
          if (!name) throw new Error('name is required');
          const covJson = covered_conditions != null
            ? JSON.stringify(Array.isArray(covered_conditions) ? covered_conditions : [])
            : null;
          conn.prepare(
            `INSERT INTO insurance_plans (name, provider, type, policy_number, premium_amount, premium_frequency, coverage_amount, start_date, end_date, renewal_date, notes, terms, covered_conditions, insured_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            String(name), provider ? String(provider) : null, String(type),
            policy_number ? String(policy_number) : null,
            premium_amount != null ? Number(premium_amount) : null,
            String(premium_frequency),
            coverage_amount != null ? Number(coverage_amount) : null,
            start_date ? String(start_date) : null,
            end_date ? String(end_date) : null,
            renewal_date ? String(renewal_date) : null,
            notes ? String(notes) : null,
            terms ? String(terms) : null,
            covJson,
            insured_name ? String(insured_name) : null
          );
        }
        results.imported++;
      } catch (err) {
        results.skipped++;
        results.errors.push({ row: i + 1, message: err.message });
      }
    }

    res.json(results);
  } catch (err) {
    if (err.code === 'PASSWORD_REQUIRED') {
      return res.status(422).json({ error: err.message, code: 'PASSWORD_REQUIRED' });
    }
    console.error('PDF import error:', err);
    res.status(500).json({ error: `Failed to import PDF: ${err.message}` });
  }
});

/**
 * POST /api/import/text
 * Parse raw text (pasted by the user) using AI and return a preview.
 * Body: { text: string, import_type?: string }
 * Returns same shape as /pdf/preview.
 */
router.post('/text', express.json({ limit: '2mb' }), async (req, res) => {
  const { text, import_type: hintType } = req.body || {};
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required and must be a non-empty string' });
  }

  try {
    const options = hintType ? { hintType } : {};
    const result = await parseStatement(text.trim(), options);
    res.json(result);
  } catch (err) {
    console.error('Text import error:', err);
    res.status(500).json({ error: `Failed to parse text: ${err.message}` });
  }
});

module.exports = router;
