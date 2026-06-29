/**
 * Fixture harness route prefix constant.
 *
 * This module defines the single canonical reserved dev prefix for the fixture
 * harness. All fixture route registration, public-path checks, browser endpoint
 * configuration, and production absence assertions must use this constant.
 *
 * SECURITY: This prefix is ONLY mounted when:
 * - NODE_ENV !== 'production'
 * - The bind host is a loopback address (127.0.0.1, localhost, ::1)
 * - The fixture harness flag is explicitly enabled
 *
 * Production builds must not contain this prefix in any route table.
 */

/**
 * Reserved dev prefix for the fixture harness.
 * All fixture routes are mounted under this prefix.
 */
export const FIXTURE_OPERATOR_PREFIX = '/__fixture/operator'
