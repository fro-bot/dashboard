/**
 * Minimal structured logger + sensitive-field redaction.
 *
 * Mirrors the `@fro-bot/runtime` `shared/logger.ts` `Logger` interface and
 * `redactSensitiveFields` helper (plan: Interface Contracts seam) so a future
 * `@fro.bot/runtime` extraction is a file-move. Standalone for Phase-1 — no
 * cross-repo dependency on the unpublished runtime package.
 *
 * Security: never log raw secrets. `redactSensitiveFields` masks any string
 * field whose name matches a sensitive pattern before it reaches a sink.
 */

export interface LogContext {
  readonly [key: string]: unknown
}

export interface Logger {
  readonly debug: (message: string, context?: LogContext) => void
  readonly info: (message: string, context?: LogContext) => void
  readonly warning: (message: string, context?: LogContext) => void
  readonly error: (message: string, context?: LogContext) => void
}

export const DEFAULT_SENSITIVE_FIELDS: readonly string[] = [
  'token',
  'password',
  'secret',
  'key',
  'auth',
  'credential',
  'bearer',
  'apikey',
  'api_key',
  'access_token',
  'refresh_token',
  'private',
] as const

const REDACTED = '[REDACTED]'

/**
 * Sanitize an error message string to strip sensitive material that could
 * appear in error text: PEM blocks, JWT-shaped strings, GitHub tokens, and
 * bearer-looking long tokens.
 *
 * This is defence-in-depth — callers should never construct errors from raw
 * auth material, but this catches accidental leakage before it reaches a log sink.
 */
export function sanitizeErrorMessage(input: string): string {
  // Strip PEM blocks (-----BEGIN ... -----END ...-----)
  let out = input.replaceAll(/-----BEGIN[^-]+-----[\s\S]*?-----END[^-]+-----/g, REDACTED)
  // Strip JWT-shaped strings (three base64url segments separated by dots)
  out = out.replaceAll(/[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g, REDACTED)
  // Strip GitHub tokens: gho_, ghs_, ghp_, ghu_, github_pat_
  out = out.replaceAll(/gh[opsu]_\w{10,}/gi, REDACTED)
  out = out.replaceAll(/github_pat_\w{10,}/gi, REDACTED)
  // Strip bearer-looking long opaque tokens (40+ chars, e.g. OAuth tokens)
  out = out.replaceAll(/\b[\w-]{40,}\b/g, REDACTED)
  return out
}

function isSensitiveField(fieldName: string, patterns: readonly string[]): boolean {
  const lower = fieldName.toLowerCase()
  return patterns.some(pattern => lower.includes(pattern.toLowerCase()))
}

/**
 * Recursively replace string values of sensitive-named fields with `[REDACTED]`.
 * Non-string sensitive values pass through (a `{key: {...}}` object is walked,
 * not masked) — matching the runtime helper's behavior.
 */
export function redactSensitiveFields<T>(value: T, patterns: readonly string[] = DEFAULT_SENSITIVE_FIELDS): T {
  if (value == null || typeof value !== 'object') {
    return value
  }

  if (Array.isArray(value)) {
    return value.map((item: unknown) => redactSensitiveFields(item, patterns)) as T
  }

  const result: Record<string, unknown> = {}
  for (const [fieldName, fieldValue] of Object.entries(value)) {
    if (isSensitiveField(fieldName, patterns) && typeof fieldValue === 'string') {
      result[fieldName] = REDACTED
    } else if (fieldValue != null && typeof fieldValue === 'object') {
      result[fieldName] = redactSensitiveFields(fieldValue, patterns)
    } else {
      result[fieldName] = fieldValue
    }
  }

  return result as T
}

function emit(
  level: 'debug' | 'info' | 'warning' | 'error',
  message: string,
  context?: LogContext,
): void {
  const line =
    context === undefined
      ? message
      : `${message} ${JSON.stringify(redactSensitiveFields(context))}`
  // Route through console.warn/error so stdout stays clean for structured output.
  if (level === 'error') {
    console.error(`[${level}] ${line}`)
  } else {
    console.warn(`[${level}] ${line}`)
  }
}

/**
 * Default console-backed logger. Every context object is redacted before
 * serialization, so a stray `{token}` in a log call cannot leak.
 */
export const logger: Logger = {
  debug: (message, context) => emit('debug', message, context),
  info: (message, context) => emit('info', message, context),
  warning: (message, context) => emit('warning', message, context),
  error: (message, context) => emit('error', message, context),
}
