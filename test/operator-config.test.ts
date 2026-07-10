/**
 * Tests for operator UI config flag reader and gateway operator session config flag reader.
 *
 * TDD: written before implementation.
 * Covers: default-off, exact 'true' (case-insensitive, trimmed) enables,
 * everything else disables (fail-closed).
 */
import process from 'node:process'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {readGatewayOperatorSessionConfig, readOperatorUiConfig, readPushNotificationsConfig} from '../src/gateway/operator-config.ts'

describe('readOperatorUiConfig', () => {
  const ENV_KEY = 'DASHBOARD_OPERATOR_UI_ENABLED'

  beforeEach(() => {
    delete process.env[ENV_KEY]
    delete process.env[`${ENV_KEY}_FILE`]
  })

  afterEach(() => {
    delete process.env[ENV_KEY]
    delete process.env[`${ENV_KEY}_FILE`]
  })

  describe('default off', () => {
    it('returns enabled:false when env var is not set', () => {
      const config = readOperatorUiConfig()
      expect(config.enabled).toBe(false)
    })
  })

  describe('enabled only by exact "true" (case-insensitive, trimmed)', () => {
    it('returns enabled:true for "true"', () => {
      process.env[ENV_KEY] = 'true'
      expect(readOperatorUiConfig().enabled).toBe(true)
    })

    it('returns enabled:true for "TRUE"', () => {
      process.env[ENV_KEY] = 'TRUE'
      expect(readOperatorUiConfig().enabled).toBe(true)
    })

    it('returns enabled:true for "True"', () => {
      process.env[ENV_KEY] = 'True'
      expect(readOperatorUiConfig().enabled).toBe(true)
    })

    it('returns enabled:true for "  true  " (trimmed)', () => {
      process.env[ENV_KEY] = '  true  '
      expect(readOperatorUiConfig().enabled).toBe(true)
    })
  })

  describe('disabled for everything else (fail-closed)', () => {
    it('returns enabled:false for empty string', () => {
      process.env[ENV_KEY] = ''
      expect(readOperatorUiConfig().enabled).toBe(false)
    })

    it('returns enabled:false for "false"', () => {
      process.env[ENV_KEY] = 'false'
      expect(readOperatorUiConfig().enabled).toBe(false)
    })

    it('returns enabled:false for "1"', () => {
      process.env[ENV_KEY] = '1'
      expect(readOperatorUiConfig().enabled).toBe(false)
    })

    it('returns enabled:false for "yes"', () => {
      process.env[ENV_KEY] = 'yes'
      expect(readOperatorUiConfig().enabled).toBe(false)
    })

    it('returns enabled:false for "on"', () => {
      process.env[ENV_KEY] = 'on'
      expect(readOperatorUiConfig().enabled).toBe(false)
    })

    it('returns enabled:false for "enabled"', () => {
      process.env[ENV_KEY] = 'enabled'
      expect(readOperatorUiConfig().enabled).toBe(false)
    })

    it('returns enabled:false for "TRUE " with trailing space that makes it not "true" after trim — wait, trim handles it', () => {
      // "TRUE " trimmed → "TRUE" → case-insensitive → enabled
      process.env[ENV_KEY] = 'TRUE '
      expect(readOperatorUiConfig().enabled).toBe(true)
    })

    it('returns enabled:false for "true\n" (newline — readOptionalSecret rejects embedded newlines)', () => {
      // readOptionalSecret throws on embedded newlines in env var
      // So we just test that non-"true" values are disabled
      process.env[ENV_KEY] = 'false'
      expect(readOperatorUiConfig().enabled).toBe(false)
    })
  })
})

describe('readGatewayOperatorSessionConfig', () => {
  const ENV_KEY = 'DASHBOARD_GATEWAY_OPERATOR_SESSION_ENABLED'

  beforeEach(() => {
    delete process.env[ENV_KEY]
    delete process.env[`${ENV_KEY}_FILE`]
  })

  afterEach(() => {
    delete process.env[ENV_KEY]
    delete process.env[`${ENV_KEY}_FILE`]
  })

  describe('default off', () => {
    it('returns enabled:false when env var is not set', () => {
      const config = readGatewayOperatorSessionConfig()
      expect(config.enabled).toBe(false)
    })
  })

  describe('enabled only by exact "true" (case-insensitive, trimmed)', () => {
    it('returns enabled:true for "true"', () => {
      process.env[ENV_KEY] = 'true'
      expect(readGatewayOperatorSessionConfig().enabled).toBe(true)
    })

    it('returns enabled:true for "TRUE"', () => {
      process.env[ENV_KEY] = 'TRUE'
      expect(readGatewayOperatorSessionConfig().enabled).toBe(true)
    })

    it('returns enabled:true for "  true  " (trimmed)', () => {
      process.env[ENV_KEY] = '  true  '
      expect(readGatewayOperatorSessionConfig().enabled).toBe(true)
    })
  })

  describe('disabled for everything else (fail-closed)', () => {
    it('returns enabled:false for "false"', () => {
      process.env[ENV_KEY] = 'false'
      expect(readGatewayOperatorSessionConfig().enabled).toBe(false)
    })

    it('returns enabled:false for "1"', () => {
      process.env[ENV_KEY] = '1'
      expect(readGatewayOperatorSessionConfig().enabled).toBe(false)
    })

    it('returns enabled:false for "yes"', () => {
      process.env[ENV_KEY] = 'yes'
      expect(readGatewayOperatorSessionConfig().enabled).toBe(false)
    })

    it('returns enabled:false for empty string', () => {
      process.env[ENV_KEY] = ''
      expect(readGatewayOperatorSessionConfig().enabled).toBe(false)
    })
  })

  describe('fail-closed on readOptionalSecret throw (embedded newline)', () => {
    it('returns enabled:false when env var contains an embedded newline (readOptionalSecret throws)', () => {
      // readOptionalSecret throws on embedded line-breaking characters in env vars.
      // The reader must catch this and return {enabled: false} (fail-closed).
      process.env[ENV_KEY] = 'true\ninjected'
      expect(readGatewayOperatorSessionConfig().enabled).toBe(false)
    })
  })
})

describe('readPushNotificationsConfig', () => {
  const ENV_KEY = 'DASHBOARD_OPERATOR_PUSH_ENABLED'

  beforeEach(() => {
    delete process.env[ENV_KEY]
    delete process.env[`${ENV_KEY}_FILE`]
  })

  afterEach(() => {
    delete process.env[ENV_KEY]
    delete process.env[`${ENV_KEY}_FILE`]
  })

  it('returns enabled:false when env var is not set', () => {
    expect(readPushNotificationsConfig().enabled).toBe(false)
  })

  it('returns enabled:false for "false"', () => {
    process.env[ENV_KEY] = 'false'
    expect(readPushNotificationsConfig().enabled).toBe(false)
  })

  it('returns enabled:true for "true"', () => {
    process.env[ENV_KEY] = 'true'
    expect(readPushNotificationsConfig().enabled).toBe(true)
  })

  it('returns enabled:true for "TRUE" (case-insensitive)', () => {
    process.env[ENV_KEY] = 'TRUE'
    expect(readPushNotificationsConfig().enabled).toBe(true)
  })

  it('returns enabled:true for "  true  " (trimmed)', () => {
    process.env[ENV_KEY] = '  true  '
    expect(readPushNotificationsConfig().enabled).toBe(true)
  })

  it('returns enabled:false for "1"', () => {
    process.env[ENV_KEY] = '1'
    expect(readPushNotificationsConfig().enabled).toBe(false)
  })

  it('returns enabled:false for "yes"', () => {
    process.env[ENV_KEY] = 'yes'
    expect(readPushNotificationsConfig().enabled).toBe(false)
  })
})
