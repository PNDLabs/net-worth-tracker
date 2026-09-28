# net-worth-tracker

A full-stack web application to track your personal net worth across all financial accounts, investments, real estate, and liabilities.

## Features

- 📊 **Dashboard** — real-time net worth, asset/liability breakdown, and trend charts
- 👨‍👩‍👧 **Family Net Worth** — track net worth by family member with total family roll-up
- 🏦 **Accounts** — bank accounts (checking, savings, CDs) and investment accounts (brokerage, 401k, IRA, Roth IRA) with individual holdings
- 🏠 **Assets** — real estate, vehicles, crypto, collectibles, business interests
- 💳 **Liabilities** — mortgage, auto loans, student loans, credit cards, HELOCs
- 💸 **Expenses** — upload bank & credit card statements (PDF/CSV); transactions are classified into categories, investments and income, and credit card bill payments are never double counted
- 📈 **History** — time-series snapshots with a line chart
- 📥 **Import** — bulk import via PDF, CSV or JSON for bank/investment statements

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18 + Vite |
| Charting | Recharts |
| Backend | Node.js 18+ / Express 4 |
| Database | SQLite (better-sqlite3) |
| Testing | Jest + Supertest |
| CSV parsing | csv-parse |

## Docker Compose (recommended for local hosting)

This is the recommended way to run the app locally. Everything runs in Docker:
the backend API, the React frontend, and an **nginx reverse proxy that enforces
HTTP Basic Auth** so your financial data is never exposed without a password.

**Prerequisites:** [Docker](https://docs.docker.com/get-docker/) with the Compose plugin (bundled with Docker Desktop).

### 1. Create your `.env` file

```bash
cp .env.example .env
```

Open `.env` and set a strong password:

```
BASIC_AUTH_USER=admin
BASIC_AUTH_PASS=your-strong-password-here
```

### 2. Build and start

```bash
docker compose up --build -d
```

Open **http://localhost** in your browser. You will be prompted for the
username and password you set above.

Your data is stored in a named Docker volume (`net-worth-tracker_data`) so it
persists across restarts and rebuilds.

### 3. Stop / restart

```bash
docker compose down          # stop containers (data is kept)
docker compose down -v       # stop and DELETE all data
docker compose restart       # restart without rebuilding
docker compose up --build -d # rebuild images and restart
```

---

## Manual Quick Start (development)

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
| POST | `/api/expenses/preview` | Parse a bank/card statement (nothing saved) |
| POST | `/api/expenses/commit` | Save reviewed transactions |
| GET | `/api/expenses/summary?month=YYYY-MM` | Monthly income, spending, invested, savings rate |
| GET | `/api/expenses/trend?months=12` | Monthly series |
| GET | `/api/expenses/transactions` | List transactions (filters: month, kind, category, member, needs_review) |
| PUT | `/api/expenses/transactions/:id` | Change kind/category (optionally remember for the merchant) |
| GET / DELETE | `/api/expenses/statements[/:id]` | List / undo uploaded statements |
| GET / DELETE | `/api/expenses/rules[/:id]` | List / forget learned merchant rules |

## Running Tests

```bash
cd backend
npm test
```

All tests should pass (189 at v1.10.0), covering accounts, holdings, assets, liabilities, insurance, metals, net worth, snapshots, imports, export, and the expenses module.

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

## Android APK

The CI workflow (`.github/workflows/android.yml`) automatically builds an Android APK on every push to `main` and on every `v*` tag.

| Trigger | Artifact | Signed? |
|---------|----------|---------|
| Push to `main` / PR | `net-worth-tracker-debug-<sha>` (`app-debug.apk`) | ✅ debug key |
| `v*` tag | `net-worth-tracker-release-<tag>` (`app-release.apk`) | ✅ release key (via secrets) |

The debug APK is signed with the Android debug keystore and can be sideloaded immediately (enable **Install unknown apps** for your file manager or browser in Android settings).

### Setting up release signing (required for tag builds)

Generate a release keystore **once** on your local machine and store it as repository secrets:

```bash
# 1. Generate keystore
keytool -genkey -v -keystore release.keystore \
  -alias net-worth-tracker -keyalg RSA -keysize 2048 -validity 10000

# 2. Base64-encode it (copy the output)
#    Linux:
base64 -w 0 release.keystore
#    macOS:
base64 -i release.keystore
```

Then add the following **Actions secrets** under *Settings → Secrets and variables → Actions*:

| Secret name | Value |
|-------------|-------|
| `KEYSTORE_BASE64` | Base64 output from the command above |
| `KEYSTORE_PASSWORD` | Keystore store password |
| `KEY_ALIAS` | `net-worth-tracker` (or the alias you chose) |
| `KEY_PASSWORD` | Key password |

> **Keep the keystore file safe.** If it is lost you cannot update a previously installed APK with the same signature — users would need to uninstall before reinstalling.

## License

MIT — see [LICENSE](LICENSE).
