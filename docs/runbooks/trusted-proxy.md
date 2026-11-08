# Trusted proxy and client address

How the dashboard decides which client a request came from, for per-client rate limiting.

## Why it needs configuration

The app is served behind Caddy (`marcusrbrown/infra`, `apps/dashboard/config/Caddyfile`). The app container
publishes no port, so every connection's socket peer is the Caddy container on the `dashboard_default`
Compose network. Keying the limiter on the socket address would put every client in one bucket.

Caddy's `reverse_proxy` sets `X-Forwarded-For` to the client address and ignores any value the client sent
(no `trusted_proxies` is configured). The header is therefore reliable only when the socket peer is Caddy;
from any other peer a client can forge it.

## Configuration

`DASHBOARD_TRUSTED_PROXIES` is a comma-separated list of proxy addresses or CIDR ranges, for example
`172.18.0.0/16`. Entries are validated at startup; a malformed value stops the server. `/0` prefixes and
unspecified addresses are refused because they would trust every peer.

- Unset or blank: no proxy is trusted. The socket address is the client and `X-Forwarded-For` is ignored.
  Behind Caddy this is one shared bucket.
- Set: when the socket peer matches an entry, `X-Forwarded-For` is read from the right and the first address
  that is not itself a trusted proxy is the client. Entries further left are client-supplied and never used.
  A missing, oversized (over 4 KiB or 32 entries) or malformed header falls back to the proxy's own bucket.
- A peer that matches no entry is keyed on its socket address, whatever header it sends.

The Caddy container's address on `dashboard_default` is assigned by Docker and is not pinned in the compose
file, so use the network's subnet (`docker network inspect dashboard_default`) or pin the network subnet in
`marcusrbrown/infra` and trust that range. Trust only the network that holds the proxy.

## Bucketing

IPv4 clients are keyed per address. IPv6 clients are keyed per /64, so one routed prefix cannot mint new
buckets by varying its low bits. IPv4-mapped IPv6 addresses count as IPv4. The key is for accounting only;
do not use it for a trust decision.

The limiter holds at most 10,000 keys. When a new key arrives at the limit the oldest key is dropped; a flood
of distinct clients can age out other counters but cannot grow the map or lock a new client out.

## Related

- `docs/solutions/security-issues/gateway-operator-oauth-rate-limit-shared-key-behind-caddy-2026-09-21.md`:
  the same collapse on the gateway, fixed there with a trusted-proxy allowlist.
