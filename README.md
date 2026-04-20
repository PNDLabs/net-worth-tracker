# net-worth-tracker

A full-stack web application to track your personal net worth across all financial accounts, investments, real estate, and liabilities.

## Features

- 📊 **Dashboard** — real-time net worth, asset/liability breakdown, and trend charts
- 🏦 **Accounts** — bank accounts (checking, savings, CDs) and investment accounts (brokerage, 401k, IRA, Roth IRA) with individual holdings
- 🏠 **Assets** — real estate, vehicles, crypto, collectibles, business interests
- 💳 **Liabilities** — mortgage, auto loans, student loans, credit cards, HELOCs
- 📈 **History** — time-series snapshots with a line chart
- 📥 **Import** — bulk import via CSV or JSON for bank/investment statements

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18 + Vite |
| Charting | Recharts |
| Backend | Node.js 18+ / Express 4 |
| Database | SQLite (better-sqlite3) |
| Testing | Jest + Supertest |
| CSV parsing | csv-parse |

## Quick Start

**Prerequisites:** Node.js 18+

### 1. Clone & Install

```bash
git clone https://github.com/PNDLabs/net-worth-tracker.git
cd net-worth-tracker

# Install backend deps
cd backend && npm install

# Install frontend deps
cd ../frontend && npm install
```

### 2. Start the Backend

```bash
cd backend
npm start
# API runs on http://localhost:3001
```

### 3. Start the Frontend

In a separate terminal:

```bash
cd frontend
npm run dev
# UI runs on http://localhost:5173
```

Open **http://localhost:5173** in your browser.

## Project Structure

```
net-worth-tracker/
├── docs/
│   └── PRD.md                  # Product Requirements Document
├── backend/
│   ├── src/
│   │   ├── app.js              # Express app factory
│   │   ├── server.js           # Entry point
│   │   ├── db/database.js      # SQLite setup & migrations
│   │   └── routes/
│   │       ├── accounts.js     # Accounts & holdings API
│   │       ├── assets.js       # Assets API
│   │       ├── liabilities.js  # Liabilities API
│   │       ├── networth.js     # Net worth summary & snapshots
│   │       └── importRoutes.js # CSV / JSON import
│   ├── tests/api.test.js       # 35 integration tests
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── App.jsx             # Root component + navigation
│   │   ├── hooks/
│   │   │   ├── api.js          # API client
│   │   │   └── format.js       # Currency / date formatters
│   │   └── pages/
│   │       ├── Dashboard.jsx
│   │       ├── AccountsPage.jsx
│   │       ├── AssetsPage.jsx
│   │       ├── LiabilitiesPage.jsx
│   │       ├── HistoryPage.jsx
│   │       └── ImportPage.jsx
│   └── package.json
└── data/                       # SQLite database (auto-created)
```

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/accounts` | List all accounts |
| POST | `/api/accounts` | Create account |
| PUT | `/api/accounts/:id` | Update account |
| DELETE | `/api/accounts/:id` | Delete account |
| GET | `/api/accounts/:id/holdings` | List holdings |
| POST | `/api/accounts/:id/holdings` | Add holding |
| GET | `/api/assets` | List all assets |
| POST | `/api/assets` | Create asset |
| PUT | `/api/assets/:id` | Update asset |
| DELETE | `/api/assets/:id` | Delete asset |
| GET | `/api/liabilities` | List all liabilities |
| POST | `/api/liabilities` | Create liability |
| PUT | `/api/liabilities/:id` | Update liability |
| DELETE | `/api/liabilities/:id` | Delete liability |
| GET | `/api/networth` | Current net worth summary |
| GET | `/api/networth/snapshots` | List snapshots |
| POST | `/api/networth/snapshots` | Record a snapshot |
| POST | `/api/import/csv?import_type=<type>` | Import CSV file |
| POST | `/api/import/json` | Import JSON records |

## Running Tests

```bash
cd backend
npm test
```

All 35 tests should pass covering Accounts, Holdings, Assets, Liabilities, Net Worth calculation, Snapshots, CSV/JSON import, and the health endpoint.

## CSV Import Format

Upload a CSV matching the columns below. Use **Import → CSV** in the UI.

**Accounts:**
```csv
name,institution,type,currency,balance
Chase Checking,Chase Bank,checking,USD,5000
```

**Assets:**
```csv
name,category,acquisition_date,acquisition_cost,current_value
Primary Home,real_estate,2020-06-15,350000,420000
```

**Liabilities:**
```csv
name,lender,type,original_principal,current_balance,interest_rate,minimum_payment
Home Mortgage,Wells Fargo,mortgage,400000,375000,3.5,2100
```

## License

MIT — see [LICENSE](LICENSE).
