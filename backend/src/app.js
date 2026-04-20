const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const accountsRouter = require('./routes/accounts');
const assetsRouter = require('./routes/assets');
const liabilitiesRouter = require('./routes/liabilities');
const networthRouter = require('./routes/networth');
const importRouter = require('./routes/importRoutes');

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

function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json());

  app.use('/api/accounts', apiLimiter, accountsRouter);
  app.use('/api/assets', apiLimiter, assetsRouter);
  app.use('/api/liabilities', apiLimiter, liabilitiesRouter);
  app.use('/api/networth', apiLimiter, networthRouter);
  app.use('/api/import', importLimiter, importRouter);

  // Health check
  app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

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
