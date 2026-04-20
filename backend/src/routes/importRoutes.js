const express = require('express');
const router = express.Router();
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const db = require('../db/database');
const { extractPdfText } = require('../utils/pdfExtractor');
const { parseStatement } = require('../utils/statementParser');

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
router.post('/csv', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const importType = req.query.import_type || 'accounts';
  const VALID_IMPORT_TYPES = ['accounts', 'assets', 'liabilities'];
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
  const results = { imported: 0, skipped: 0, errors: [] };

  const normalizeKeys = (obj) => {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k.toLowerCase().replace(/\s+/g, '_')] = v;
    }
    return out;
  };

  const importRow = conn.transaction((record) => {
    const row = normalizeKeys(record);

    if (importType === 'accounts') {
      const { name, institution, type = 'other', currency = 'USD', balance = 0 } = row;
      if (!name) throw new Error('name is required');
      conn.prepare(
        `INSERT INTO accounts (name, institution, type, currency, balance)
         VALUES (?, ?, ?, ?, ?)`
      ).run(String(name), institution ? String(institution) : null, String(type), String(currency), Number(balance));

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
    }
  });

  for (let i = 0; i < records.length; i++) {
    try {
      importRow(records[i]);
      results.imported++;
    } catch (err) {
      results.skipped++;
      results.errors.push({ row: i + 2, message: err.message });
    }
  }

  res.json(results);
});

/**
 * POST /api/import/json
 * Body: { import_type: 'accounts'|'assets'|'liabilities', records: [...] }
 */
router.post('/json', express.json({ limit: '10mb' }), (req, res) => {
  const { import_type: importType = 'accounts', records } = req.body || {};

  if (!Array.isArray(records) || records.length === 0) {
    return res.status(400).json({ error: 'records must be a non-empty array' });
  }

  const VALID_IMPORT_TYPES = ['accounts', 'assets', 'liabilities'];
  if (!VALID_IMPORT_TYPES.includes(importType)) {
    return res.status(400).json({ error: `import_type must be one of: ${VALID_IMPORT_TYPES.join(', ')}` });
  }

  const conn = db.getDb();
  const results = { imported: 0, skipped: 0, errors: [] };

  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    try {
      if (importType === 'accounts') {
        const { name, institution, type = 'other', currency = 'USD', balance = 0 } = row;
        if (!name) throw new Error('name is required');
        conn.prepare(
          `INSERT INTO accounts (name, institution, type, currency, balance) VALUES (?, ?, ?, ?, ?)`
        ).run(String(name), institution ? String(institution) : null, String(type), String(currency), Number(balance));

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
 *   ai_api_key  – override AI API key (optional; falls back to server env)
 */
router.post('/pdf/preview', upload.single('file'), async (req, res) => {
  if (!validatePdfFile(req, res)) return;

  try {
    const text = await extractPdfText(req.file.buffer, req.body.password || '');
    if (!text.trim()) {
      return res.status(422).json({ error: 'Could not extract text from PDF. The file may be scanned/image-only.' });
    }

    const options = {};
    if (req.body.ai_api_key) options.apiKey = req.body.ai_api_key;

    const result = await parseStatement(text, options);
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
 *   import_type – optional override ('accounts'|'assets'|'liabilities')
 */
router.post('/pdf', upload.single('file'), async (req, res) => {
  if (!validatePdfFile(req, res)) return;

  try {
    const text = await extractPdfText(req.file.buffer, req.body.password || '');
    if (!text.trim()) {
      return res.status(422).json({ error: 'Could not extract text from PDF.' });
    }

    const options = {};
    if (req.body.ai_api_key) options.apiKey = req.body.ai_api_key;

    const parsed = await parseStatement(text, options);

    // Allow caller to override the detected import type
    const importType = req.body.import_type || parsed.import_type;
    const VALID = ['accounts', 'assets', 'liabilities'];
    if (!VALID.includes(importType)) {
      return res.status(400).json({ error: `import_type must be one of: ${VALID.join(', ')}` });
    }

    const conn = db.getDb();
    const results = { imported: 0, skipped: 0, errors: [], method: parsed.method };

    for (let i = 0; i < parsed.records.length; i++) {
      const row = parsed.records[i];
      try {
        if (importType === 'accounts') {
          const { name, institution, type = 'other', currency = 'USD', balance = 0 } = row;
          if (!name) throw new Error('name is required');
          conn.prepare(
            `INSERT INTO accounts (name, institution, type, currency, balance) VALUES (?, ?, ?, ?, ?)`
          ).run(String(name), institution ? String(institution) : null, String(type), String(currency), Number(balance));
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

module.exports = router;
