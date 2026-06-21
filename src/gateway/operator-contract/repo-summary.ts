/**
 * RepoSummary type and parse helpers for the operator contract.
 *
 * Mirrors the gateway's RepoSummary from fro-bot/agent v0.73.0 (PR #968).
 * No upstream parse helper exists for this type — the guards below are authored
 * locally following the same hand-rolled type-guard + fixed-reason-string pattern
 * used in parse.ts.
 *
 * Design constraints (same as parse.ts):
 * - NO-ORACLE: error messages are FIXED reason strings. They never echo, interpolate,
 *   or stringify any part of the input.
 * - Extra-field policy: IGNORE extra fields (permissive structural subtyping).
 * - channelName is OMITTED (key absent) when empty upstream — both {owner,repo} and
 *   {owner,repo,channelName} are valid.
 */

import type {Result} from '../../result.ts'

import {err, ok} from '../../result.ts'

// ---------------------------------------------------------------------------
// RepoSummary
// ---------------------------------------------------------------------------

export interface RepoSummary {
  readonly owner: string
  readonly repo: string
  readonly channelName?: string
}

function hasValidRepoSummaryShape(value: unknown): value is RepoSummary {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }

  const candidate = value as Record<string, unknown>

  if (typeof candidate.owner !== 'string') {
    return false
  }

  if (typeof candidate.repo !== 'string') {
    return false
  }

  // channelName is optional — if present it must be a string
  if ('channelName' in candidate && typeof candidate.channelName !== 'string') {
    return false
  }

  return true
}

/**
 * Parse an unknown value as RepoSummary.
 *
 * Returns ok(value) when the input has the required shape.
 * Returns err(Error) with a FIXED reason string when validation fails —
 * the error message never echoes any part of the input.
 */
export function parseRepoSummary(input: unknown): Result<RepoSummary, Error> {
  if (hasValidRepoSummaryShape(input) === false) {
    return err(new Error('invalid repo summary shape'))
  }

  return ok(input)
}

/**
 * Parse an unknown value as an array of RepoSummary.
 *
 * Requires a bare array. Fails the WHOLE list closed if ANY item is invalid
 * or if the input is not an array.
 *
 * Returns ok(value) when the input is an array and every item has the required shape.
 * Returns err(Error) with a FIXED reason string when validation fails —
 * the error message never echoes any part of the input.
 */
export function parseRepoSummaryList(input: unknown): Result<RepoSummary[], Error> {
  if (!Array.isArray(input)) {
    return err(new Error('invalid repo summary list: expected array'))
  }

  for (const item of input) {
    if (hasValidRepoSummaryShape(item) === false) {
      return err(new Error('invalid repo summary list: item failed validation'))
    }
  }

  return ok(input as RepoSummary[])
}
