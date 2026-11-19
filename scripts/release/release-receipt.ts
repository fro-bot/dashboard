import type {GitHubApi} from './github-release-api.ts'
import type {Obs} from './publication.ts'
import {Buffer} from 'node:buffer'
import {createHash} from 'node:crypto'

export interface ReceiptIdentity {repo: string; releaseId: number; version: string; source: string; digest: string}
export interface ReceiptBot {id: number; login: string}

const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const id = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0
const valid = (value: ReceiptIdentity, repo: string): boolean => value.repo === repo &&
  /^[\w.-]+\/[\w.-]+$/u.test(repo) && repo.split('/').every(part => part !== '.' && part !== '..') &&
  id(value.releaseId) && /^\d{4}\.\d{2}\.\d+$/u.test(value.version) && /^[a-f0-9]{40}$/u.test(value.source) && /^sha256:[a-f0-9]{64}$/u.test(value.digest)
const canonical = (value: ReceiptIdentity): Buffer => Buffer.from(JSON.stringify({schema: 1, repo: value.repo, releaseId: value.releaseId, version: value.version, source: value.source, digest: value.digest}), 'utf8')
const unknown = () => ({state: 'unknown' as const, reason: 'read-failed' as const})

/** The caller independently resolves bot from the configured publication App. */
export async function readReleaseReceipt(api: GitHubApi, expected: ReceiptIdentity, bot: ReceiptBot): Promise<Obs<ReceiptIdentity>> {
  try {
    if (!valid(expected, api.repo) || !id(bot.id) || typeof bot.login !== 'string' || bot.login.length === 0) return unknown()
    const assets = await api.releaseAssetPages(expected.releaseId)
    if (!assets.every(item => object(item) && typeof item.name === 'string')) return unknown()
    const matches = assets.filter(item => object(item) && item.name === 'release-proof.json')
    if (matches.length === 0) return {state: 'absent'}
    const item = matches[0]
    if (matches.length !== 1 || !object(item) || !id(item.id) || item.state !== 'uploaded' || !id(item.size) || item.size > 16 * 1024 ||
      typeof item.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(item.digest) || !object(item.uploader) ||
      item.uploader.id !== bot.id || item.uploader.login !== bot.login || item.uploader.type !== 'Bot') return unknown()
    const data = await api.releaseAssetBytes(item.id)
    if (data.length !== item.size || `sha256:${createHash('sha256').update(data).digest('hex')}` !== item.digest || !Buffer.from(data).equals(canonical(expected))) return unknown()
    return {state: 'present', value: {repo: expected.repo, releaseId: expected.releaseId, version: expected.version, source: expected.source, digest: expected.digest}}
  } catch { return unknown() }
}

/** One write only; caller must prove preconditions and reconcile by reading again. */
export async function uploadReleaseReceipt(api: GitHubApi, expected: ReceiptIdentity): Promise<void> {
  if (!valid(expected, api.repo)) throw new Error('Invalid release receipt')
  await api.uploadReceipt(expected.releaseId, canonical(expected))
}
