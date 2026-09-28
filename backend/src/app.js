const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const accountsRouter = require('./routes/accounts');
const assetsRouter = require('./routes/assets');
const liabilitiesRouter = require('./routes/liabilities');
const networthRouter = require('./routes/networth');
const importRouter = require('./routes/importRoutes');
const exportRouter = require('./routes/exportRoutes');
const insuranceRouter = require('./routes/insurance');
const settingsRouter = require('./routes/settings');
const valueHistoryRouter = require('./routes/valueHistory');
const metalsRouter = require('./routes/metals');
const expensesRouter = require('./routes/expenses');
const db = require('./db/database');

function createApp() {
  const app = express();

  // Rate limiters are created per app instance so that test suites using
  // createApp() get independent counters and don't trip each other's limits.

  // Standard limiter: 300 requests per minute for read/write endpoints
  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' },
  });

  // Tighter limiter for import endpoints: 30 imports per minute
  const importLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many import requests, please try again later.' },
  });

  // Trust the immediate upstream proxy (nginx). Required so express-rate-limit
  // can correctly identify clients via X-Forwarded-For. Safe because port 3001
  // is not exposed to the host – only nginx can reach the backend.
  app.set('trust proxy', 1);

  app.use(cors());
  // Expense commits carry a whole statement of transactions, which can exceed the
  // global 100 KB JSON limit. Their parser must run first: the global parser skips
  // bodies that have already been parsed.
  app.use('/api/expenses/commit', express.json({ limit: '5mb' }));
  app.use(express.json());

  app.use('/api/accounts', apiLimiter, accountsRouter);
  app.use('/api/assets', apiLimiter, assetsRouter);
  app.use('/api/liabilities', apiLimiter, liabilitiesRouter);
  app.use('/api/networth', apiLimiter, networthRouter);
  app.use('/api/insurance', apiLimiter, insuranceRouter);
  app.use('/api/settings', apiLimiter, settingsRouter);
  app.use('/api/value-history', apiLimiter, valueHistoryRouter);
  app.use('/api/metals', apiLimiter, metalsRouter);
  app.use('/api/import', importLimiter, importRouter);
  app.use('/api/export', apiLimiter, exportRouter);
  app.use('/api/expenses/preview', importLimiter);
  app.use('/api/expenses/commit', importLimiter);
  app.use('/api/expenses', apiLimiter, expensesRouter);

  // Health check
  app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

  // Server configuration (AI key availability, default currency, etc.)
  app.get('/api/config', apiLimiter, (req, res) => {
    const conn = db.getDb();
    let defaultCurrency = null;
    try {
      const row = conn.prepare('SELECT value FROM settings WHERE key = ?').get('defaultCurrency');
      if (row) defaultCurrency = JSON.parse(row.value);
    } catch (_) { /* use default */ }
    res.json({
      aiEnabled: !!(process.env.AI_API_KEY || process.env.OPENAI_API_KEY),
      defaultCurrency,
    });
  });

  // 404 handler
  app.use((req, res) => res.status(404).json({ error: 'Not found' }));

  // Error handler
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

module.exports = { createApp };
