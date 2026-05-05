/**
 * version.js – single source of truth for the app version.
 *
 * APP_VERSION follows semantic versioning (MAJOR.MINOR.PATCH):
 *   MAJOR – breaking changes (incompatible API or data formats)
 *   MINOR – new backwards-compatible features
 *   PATCH – backwards-compatible bug fixes
 *
 * Rules:
 *   • Bump APP_VERSION on EVERY feature addition, bug-fix release, or DB schema change.
 *   • Add a matching entry to CHANGELOG.md at the repo root.
 *   • DB schema changes also require incrementing DB_SCHEMA_VERSION in backend/src/db/database.js.
 */

export const APP_VERSION = '1.8.2';

/**
 * The export/import JSON schema version.
 * Increment this (as an integer) only when the export schema changes in a
 * backwards-incompatible way.  Exports produced by older schema versions
 * whose number is ≤ CURRENT_SCHEMA_VERSION are always accepted.
 */
export const EXPORT_SCHEMA_VERSION = 3;
