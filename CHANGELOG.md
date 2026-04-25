# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Versioning rules**
> - Bump `APP_VERSION` in `frontend/src/version.js` **and** both `package.json` files on every release.
> - Add an entry to this file for every change – features, fixes, and DB schema changes alike.
> - DB schema changes must also increment `DB_SCHEMA_VERSION` in `backend/src/db/database.js` and document the new schema version here.

---

## [1.7.1] – 2026-04-25

### Changed
- Precious metals spot prices are now converted from USD to the user's **default currency** using live FX rates from [open.er-api.com](https://open.er-api.com) (free, no API key required). `current_value`, `current_price_gram`, and all price-refresh responses now reflect the user's selected currency instead of always using USD.
- `GET /api/metals/spot-prices` and `POST /api/metals/refresh-prices` responses now include a `currency` field and a `{CURRENCY}_per_gram` unit string.
- MetalsPage UI labels updated to display the active currency symbol.
- Android `metalsService.js` applies the same FX conversion via `open.er-api.com`.

---

## [1.7.0] – 2026-04-25

### Added
- **Precious Metals** tracker: track gold, silver, platinum, and palladium holdings with quantity in grams, form (physical/digital), and purity (karat, millesimal fineness, percentage).
- Live spot-price refresh: `POST /api/metals/refresh-prices` fetches USD/troy-oz prices from api.metals.live and auto-updates `current_value = quantity_grams × parsePurity(purity) × price_per_gram` for every holding.
- `GET /api/metals/spot-prices` returns current spot prices without persisting them.
- Precious metals contribute to `metalsTotal` in the net worth calculation and are included in `totalAssets` in both backend and Android local API.
- Dashboard "Breakdown" table and pie chart now show a **Precious Metals** row (gold color).
- 🥇 **Metals** nav item added to the sidebar.
- Value history is auto-recorded for each metal on create and on every price/quantity change (entity_type = `'metal'`).
- Full export/import supports `precious_metals` table (export schema version bumped to 3).
- `valueHistory` valid entity types now include `'metal'` and `'insurance'`.
- Android (`metalsService.js`) mirrors all backend metals functionality including purity-aware value calculation and offline price refresh.

### Changed
- DB schema version: **4 → 5** (new `precious_metals` table + index on `metal_type`).
- Export schema version: **2 → 3** (precious_metals added to export payload).

---

## [1.6.0] – 2026-04-25

### Added
- AI-powered CSV column mapping for flexible import of arbitrary CSV files.
- Filter and sort controls on the Accounts table.
- Auto-create a vehicle asset from a vehicle insurance IDV during import.

### Changed
- User currency setting is now respected in the Net Worth History graph and table.
- Replaced all hardcoded `$` labels with the user's selected currency symbol in forms.
- Removed hardcoded `USD` defaults from JS application code; currency now always read from user settings.

### Fixed
- `onRefresh` removed from ImportPage to prevent tab reset after CSV/JSON import.

---

## [1.5.0] – 2026-04-22

### Added
- Duplicate detection in PDF/text import preview with per-row "Import anyway" checkbox.
- `insured_name` field on insurance plans (auto-detected during import). **DB schema v3**

### Changed
- `insurance_plans` table: added `insured_name` column (migration 3).

### Fixed
- `PdfPreviewPanel` `useEffect` dependency array corrected; per-type duplicate check cache.
- Populated `insured_name`, `terms`, and `covered_conditions` on insurance import across all paths.

---

## [1.4.0] – 2026-04-20

### Added
- Multi-pass AI review for accurate currency, amount, and account-type parsing (Pass 3 conditional on Pass 2 corrections).
- `insurance_plans.linked_asset_id` FK column to associate a plan with an asset. **DB schema v4**

### Changed
- `insurance_plans` table: added `linked_asset_id` column (migration 4).

### Fixed
- Regex safety, schema guard, and comment clarity fixes in statement parser.
- EPFO/PF passbooks correctly classified as accounts (pension) rather than liabilities.

---

## [1.3.0] – 2026-04-15

### Added
- Insurance plan coverage query (POST `/api/insurance/query`) and AI analysis (GET `/api/insurance/analysis`).
- `insurance_plans.terms` and `insurance_plans.covered_conditions` columns. **DB schema v2**
- Collapsible "Coverage Details" UI on the Insurance page.

### Changed
- `insurance_plans` table: added `terms` and `covered_conditions` columns (migration 2).
- Net worth calculation: removed SIP installments total to avoid double-counting with investment account balances.
- Dashboard splits accounts into `cashTotal` (checking/savings/CD) and `investmentAccountsTotal` (all other types).

### Fixed
- Use American spelling ("Analyze") consistently across insurance AI prompts and UI.

---

## [1.2.0] – 2026-04-10

### Added
- `value_history` table: auto-records account balance, asset `current_value`, and liability `current_balance` on create and on value change.
- Routes: `GET /api/value-history`, `POST /api/value-history`, `GET /api/value-history/growth`.
- `sip_installments` table to track SIP payment history (cost basis).

### Fixed
- SIP/mutual fund installments included in net worth calculation.
- Corrected distinct SIP name usage in net worth tests.

---

## [1.1.0] – 2026-04-05

### Added
- Full data export (`GET /api/export`) and import (`POST /api/export/import`).
- `APP_VERSION` constant in `frontend/src/version.js` (single source of truth).
- `EXPORT_SCHEMA_VERSION` (integer) for export/import JSON schema compatibility.
- Android SQLite service layer under `frontend/src/db/`.
- `apiAdapter.js` routing API calls to REST (web/Docker) or local SQLite (Android).

---

## [1.0.0] – 2026-03-15

### Added
- Initial release: accounts, holdings, assets, liabilities, snapshots, insurance plans, settings. **DB schema v1**
- Backend REST API (Express + better-sqlite3).
- React frontend with Capacitor 6 Android support.
- AI-powered bank/brokerage statement PDF import.
