/**
 * version.js – single source of truth for the app version.
 *
 * Bump this whenever a new release is shipped so the export schema header
 * and the Settings page always show the current build version.
 */

export const APP_VERSION = '1.0.0';

/**
 * The export/import JSON schema version.
 * Increment this (as an integer) only when the export schema changes in a
 * backwards-incompatible way.  Exports produced by older schema versions
 * whose number is ≤ CURRENT_SCHEMA_VERSION are always accepted.
 */
export const EXPORT_SCHEMA_VERSION = 2;
