/**
 * Client address resolution for abuse accounting (rate limiting).
 *
 * The app runs behind a reverse proxy (Caddy), so the TCP peer is the proxy for every
 * request. The real client address arrives in `X-Forwarded-For`, which a client can also
 * forge. The header is therefore read only when the socket peer is a configured trusted
 * proxy (`DASHBOARD_TRUSTED_PROXIES`); from any other peer it is ignored. With no proxy
 * configured the socket address is always the client.
 *
 * The result is an accounting key, not an identity: IPv4 is keyed per address and IPv6
 * per /64, because one routed /64 holds 2^64 addresses and would otherwise be a free
 * supply of fresh keys. Never use the key for a trust decision.
 */
import {Buffer} from 'node:buffer'
import {BlockList, isIPv4, isIPv6} from 'node:net'

export const MAX_FORWARDED_FOR_BYTES = 4096
export const MAX_FORWARDED_FOR_ENTRIES = 32
const UNKNOWN_CLIENT_KEY = 'unknown'
const TRUSTED_PROXIES_VARIABLE = 'DASHBOARD_TRUSTED_PROXIES'

export type TrustedProxies =
  | {readonly kind: 'direct'}
  | {readonly kind: 'trusted-proxy'; readonly peers: BlockList}

type ParsedAddress =
  | {readonly family: 'ipv4'; readonly text: string}
  | {readonly family: 'ipv6'; readonly groups: readonly number[]}

export interface RawClientInput {
  /** Remote address of the TCP connection, when the server exposes one. */
  readonly socketAddress: string | undefined
  /** Every `X-Forwarded-For` value, joined as the Fetch API combines repeated headers. */
  readonly forwardedFor: string | null
}

function ipv6GroupsOf(part: string): number[] {
  if (part === '') return []
  const groups: number[] = []
  for (const piece of part.split(':')) {
    if (piece.includes('.')) {
      const [a = 0, b = 0, c = 0, d = 0] = piece.split('.').map(Number)
      groups.push((a << 8) | b, (c << 8) | d)
    } else {
      groups.push(Number.parseInt(piece, 16))
    }
  }
  return groups
}

/** Parse one address into its canonical form. IPv4-mapped IPv6 collapses to IPv4. */
function parseAddress(raw: string): ParsedAddress | undefined {
  const token = raw.trim()
  if (isIPv4(token)) return {family: 'ipv4', text: token}
  if (!isIPv6(token) || token.includes('%')) return undefined

  const compression = token.indexOf('::')
  let groups: number[]
  if (compression === -1) {
    groups = ipv6GroupsOf(token)
  } else {
    const head = ipv6GroupsOf(token.slice(0, compression))
    const tail = ipv6GroupsOf(token.slice(compression + 2))
    groups = [...head, ...Array.from({length: 8 - head.length - tail.length}, () => 0), ...tail]
  }

  const mapped = groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xFF_FF
  if (mapped) {
    const high = groups[6] ?? 0
    const low = groups[7] ?? 0
    return {family: 'ipv4', text: `${high >> 8}.${high & 0xFF}.${low >> 8}.${low & 0xFF}`}
  }
  return {family: 'ipv6', groups}
}

function ipv6Text(groups: readonly number[]): string {
  return groups.map(group => group.toString(16)).join(':')
}

function isTrusted(address: ParsedAddress, proxies: TrustedProxies): boolean {
  if (proxies.kind === 'direct') return false
  return address.family === 'ipv4'
    ? proxies.peers.check(address.text, 'ipv4')
    : proxies.peers.check(ipv6Text(address.groups), 'ipv6')
}

function accountingKey(address: ParsedAddress): string {
  if (address.family === 'ipv4') return `ipv4:${address.text}`
  const prefix = address.groups
    .slice(0, 4)
    .map(group => group.toString(16).padStart(4, '0'))
    .join(':')
  return `ipv6/64:${prefix}`
}

function invalidProxy(entry: string, reason: string): Error {
  return new Error(`Invalid ${TRUSTED_PROXIES_VARIABLE} entry "${entry}": ${reason}`)
}

/**
 * Parse `DASHBOARD_TRUSTED_PROXIES`: a comma-separated list of proxy addresses or CIDR
 * ranges (the Docker network subnet when the proxy's container address is not pinned).
 * Unset or blank means no proxy is trusted. Throws on a malformed entry so a typo cannot
 * silently disable, or widen, the trust boundary. `/0` and unspecified addresses are
 * refused because they would trust every peer.
 */
export function parseTrustedProxies(raw: string | undefined): TrustedProxies {
  if (raw === undefined || raw.trim() === '') return {kind: 'direct'}

  const peers = new BlockList()
  for (const rawEntry of raw.split(',')) {
    const entry = rawEntry.trim()
    const [addressPart = '', prefixPart, ...rest] = entry.split('/')
    const address = parseAddress(addressPart)
    if (address === undefined || rest.length > 0) throw invalidProxy(entry, 'not an IP address or CIDR range')

    const unspecified =
      address.family === 'ipv4' ? address.text === '0.0.0.0' : address.groups.every(group => group === 0)
    if (unspecified) throw invalidProxy(entry, 'unspecified address')

    if (prefixPart === undefined) {
      if (address.family === 'ipv4') peers.addAddress(address.text, 'ipv4')
      else peers.addAddress(ipv6Text(address.groups), 'ipv6')
      continue
    }

    const maxPrefix = address.family === 'ipv4' ? 32 : 128
    const prefix = /^\d{1,3}$/u.test(prefixPart) ? Number(prefixPart) : -1
    if (prefix < 1 || prefix > maxPrefix) throw invalidProxy(entry, `prefix length must be 1-${maxPrefix}`)
    if (address.family === 'ipv4') peers.addSubnet(address.text, prefix, 'ipv4')
    else peers.addSubnet(ipv6Text(address.groups), prefix, 'ipv6')
  }
  return {kind: 'trusted-proxy', peers}
}

/**
 * Resolve the rate-limit key for one request.
 *
 * Socket peer not trusted (or no proxy configured): the socket address, header ignored.
 * Socket peer trusted: walk `X-Forwarded-For` from the right (the entry the proxy itself
 * appended) and take the first address that is not itself a trusted proxy. Entries to the
 * left of it are client-supplied and never read. An absent, oversized or malformed header
 * falls back to the proxy's own key, so the limiter degrades to one shared bucket rather
 * than failing open or throwing.
 */
export function resolveClientKey(input: RawClientInput, proxies: TrustedProxies): string {
  if (input.socketAddress === undefined) return UNKNOWN_CLIENT_KEY
  const socket = parseAddress(input.socketAddress)
  if (socket === undefined) return UNKNOWN_CLIENT_KEY

  if (!isTrusted(socket, proxies)) return accountingKey(socket)
  const socketKey = accountingKey(socket)

  const header = input.forwardedFor
  if (header === null || header.trim() === '') return socketKey
  if (Buffer.byteLength(header, 'utf8') > MAX_FORWARDED_FOR_BYTES) return socketKey
  const rawEntries = header.split(',')
  if (rawEntries.length > MAX_FORWARDED_FOR_ENTRIES) return socketKey

  const entries: ParsedAddress[] = []
  for (const rawEntry of rawEntries) {
    const parsed = parseAddress(rawEntry)
    if (parsed === undefined) return socketKey
    entries.push(parsed)
  }

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const candidate = entries[index]
    if (candidate !== undefined && !isTrusted(candidate, proxies)) return accountingKey(candidate)
  }
  return socketKey
}
