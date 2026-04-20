# Net Worth Tracker — Product Requirements Document

**Version:** 1.0  
**Date:** 2026-04-20  
**Owner:** PNDLabs

---

## 1. Overview

Net Worth Tracker is a personal finance web application that aggregates all financial assets and liabilities into a single dashboard so that users can understand, monitor, and grow their net worth over time.

A user's **net worth** is defined as:

> **Net Worth = Total Assets − Total Liabilities**

The application accepts data from monthly bank statements, investment/brokerage statements, stock holdings reports, real-estate valuations, and any other financial document the user wishes to track.

---

## 2. Goals

| # | Goal |
|---|------|
| G1 | Provide a single place to view an up-to-date net worth snapshot |
| G2 | Support manual entry **and** structured file import (CSV / JSON) |
| G3 | Track the complete history of net worth changes over time |
| G4 | Be simple enough to self-host with zero external services |
| G5 | Keep all financial data local (no third-party cloud sync) |

---

## 3. Users & Personas

| Persona | Description |
|---------|-------------|
| **Individual Investor** | Tracks personal savings, brokerage accounts, and real-estate holdings |
| **Household Finance Manager** | Tracks joint bank accounts, mortgage, car loans, and household assets |
| **Small Business Owner** | Tracks both personal and business financial positions separately |

---

## 4. Features

### 4.1 Account Management
- Add / edit / delete financial accounts (checking, savings, money-market, CD)
- Each account has: name, institution, account type, currency, current balance
- Balance is updated manually or via statement import

### 4.2 Investment & Brokerage Tracking
- Track investment accounts (401k, IRA, Roth IRA, brokerage, pension)
- Record individual holdings: ticker symbol, shares, cost basis, current value
- Aggregate portfolio value per account and across all accounts

### 4.3 Asset Tracking
- Track non-account assets: real estate, vehicles, collectibles, crypto, business interests
- Each asset: name, category, acquisition date, acquisition cost, current estimated value

### 4.4 Liability Tracking
- Track debts: mortgage, auto loan, student loan, personal loan, credit card balance, HELOC
- Each liability: name, lender, original principal, current balance, interest rate, minimum payment

### 4.5 Net Worth Dashboard
- Real-time net worth figure = total assets − total liabilities
- Breakdown by category (cash, investments, real estate, other assets vs. liabilities)
- Trend chart showing net worth over time (monthly snapshots)

### 4.6 Statement Import
- CSV import for bank and investment account transactions/balances
- JSON import for programmatic integration
- Import wizard maps columns to internal fields
- Duplicate detection to prevent double-counting

### 4.7 Historical Snapshots
- Automatically record a net-worth snapshot each time balances are updated
- User can also manually trigger a snapshot ("Record today's snapshot")
- View month-by-month history table and line chart

### 4.8 Multi-Currency Support (Phase 2)
- Store balances in their native currency
- Convert to a user-chosen base currency for the summary using exchange-rate overrides

---

## 5. Technical Architecture

```
┌─────────────────────────────────────────────────┐
│                  Browser (React)                 │
│  Dashboard │ Accounts │ Assets │ Liabilities     │
│  History   │ Import   │ Settings                 │
└────────────────────┬────────────────────────────┘
                     │ REST API (JSON)
┌────────────────────▼────────────────────────────┐
│           Backend  (Node.js + Express)           │
│  /api/accounts  /api/assets  /api/liabilities   │
│  /api/networth  /api/snapshots  /api/import     │
└────────────────────┬────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────┐
│             SQLite (better-sqlite3)              │
│  accounts │ holdings │ assets │ liabilities     │
│  snapshots │ import_logs                        │
└─────────────────────────────────────────────────┘
```

### 5.1 Tech Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Frontend | React 18 + Vite | Fast SPA, rich ecosystem |
| Charting | Recharts | Lightweight, React-native charts |
| Backend | Node.js 18+ / Express 4 | Widely known, minimal overhead |
| Database | SQLite via better-sqlite3 | Zero-install, file-based, fast |
| Testing | Jest + Supertest | Standard Node.js testing |
| CSV parsing | csv-parse | Battle-tested streaming parser |
| Styling | Plain CSS (CSS variables) | No framework dependency |

### 5.2 Data Model

**accounts**
```
id, name, institution, type (checking|savings|money_market|cd|other),
currency, balance, notes, created_at, updated_at
```

**holdings** (investment positions inside an account)
```
id, account_id, symbol, name, shares, cost_basis, current_price,
current_value, as_of_date
```

**assets**
```
id, name, category (real_estate|vehicle|crypto|collectible|business|other),
acquisition_date, acquisition_cost, current_value, notes, created_at, updated_at
```

**liabilities**
```
id, name, lender, type (mortgage|auto|student|personal|credit_card|heloc|other),
original_principal, current_balance, interest_rate, minimum_payment,
notes, created_at, updated_at
```

**snapshots**
```
id, snapshot_date, total_assets, total_liabilities, net_worth, notes, created_at
```

---

## 6. API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/accounts | List all accounts |
| POST | /api/accounts | Create account |
| PUT | /api/accounts/:id | Update account |
| DELETE | /api/accounts/:id | Delete account |
| GET | /api/accounts/:id/holdings | List holdings for account |
| POST | /api/accounts/:id/holdings | Add holding |
| PUT | /api/holdings/:id | Update holding |
| DELETE | /api/holdings/:id | Delete holding |
| GET | /api/assets | List all assets |
| POST | /api/assets | Create asset |
| PUT | /api/assets/:id | Update asset |
| DELETE | /api/assets/:id | Delete asset |
| GET | /api/liabilities | List all liabilities |
| POST | /api/liabilities | Create liability |
| PUT | /api/liabilities/:id | Update liability |
| DELETE | /api/liabilities/:id | Delete liability |
| GET | /api/networth | Current net worth summary |
| GET | /api/snapshots | List all snapshots |
| POST | /api/snapshots | Create manual snapshot |
| POST | /api/import/csv | Import CSV file |
| POST | /api/import/json | Import JSON file |

---

## 7. User Interface Pages

| Page | Purpose |
|------|---------|
| **Dashboard** | Net worth total, breakdown pie/bar chart, recent activity |
| **Accounts** | CRUD for bank / investment accounts; holdings sub-table |
| **Assets** | CRUD for physical / non-account assets |
| **Liabilities** | CRUD for all debts |
| **History** | Line chart of net worth over time + snapshot table |
| **Import** | Upload CSV or JSON, map columns, preview, confirm |

---

## 8. Non-Functional Requirements

| # | Requirement |
|---|-------------|
| N1 | All data stored locally; no outbound network calls required |
| N2 | API response time < 200 ms for all list endpoints |
| N3 | Import handles files up to 10 MB |
| N4 | Application runs on Node.js 18+ on Linux, macOS, Windows |
| N5 | Unit + integration test coverage for all API endpoints |

---

## 9. Out of Scope (v1)

- Automatic bank feed / Plaid / Open Banking integration
- Mobile native app
- Multi-user / authentication
- Budget / expense tracking
- Tax reporting

---

## 10. Milestones

| Milestone | Deliverables |
|-----------|-------------|
| M1 — Foundation | PRD, repo scaffold, DB schema, backend skeleton |
| M2 — Core CRUD | Accounts, Assets, Liabilities APIs + React UI pages |
| M3 — Net Worth | Net worth calculation, snapshots, trend chart |
| M4 — Import | CSV/JSON import wizard |
| M5 — Polish | Validation, error handling, loading states, README |
