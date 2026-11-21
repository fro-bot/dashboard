---
title: Bound dashboard requests behind a trusted proxy
date: 2026-11-21
category: best-practices
module: dashboard
problem_type: design_pattern
component: backend
severity: medium
applies_when:
  - A reverse proxy forwards requests to a dashboard with per-client limits
  - Public requests and authenticated writes use in-memory counters
  - A signed route reads the request body before it checks the signature
tags: [rate-limit, trusted-proxy, caddy, x-forwarded-for, listener-ingest, bounded-body]
---

# Bound dashboard requests behind a trusted proxy

## Context

Caddy accepts the client connection and opens a second connection to the dashboard. The socket peer is the address at the other end of that second connection. If the dashboard uses only the peer address, all clients behind Caddy share one counter. This concerns the dashboard HTTP limiter, not the gateway OAuth limiter.

## Guidance

### Trust the connection before you read the header

`X-Forwarded-For` carries client addresses supplied by a proxy. In `src/client-address.ts:146-172`, `resolveClientKey` uses that header only if the socket peer matches `DASHBOARD_TRUSTED_PROXIES`. It validates the list, then selects the first address from the right that is not a trusted proxy. If the header is missing, oversized, malformed, or lists only trusted proxies, it uses the peer address instead.

The tracked infra [deploy script](https://github.com/marcusrbrown/infra/blob/main/apps/dashboard/src/deploy.ts) supplies the trusted range for the Docker network that connects Caddy to the dashboard. [Compose](https://github.com/marcusrbrown/infra/blob/main/apps/dashboard/docker-compose.yaml) passes the setting to the app. The tracked [Caddyfile](https://github.com/marcusrbrown/infra/blob/main/apps/dashboard/config/Caddyfile) uses `reverse_proxy` defaults for the dashboard route. By default, [Caddy ignores incoming values](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#defaults) when it sets the forwarded headers. The tracked files do not establish the live network range or container settings.

### Keep counters for authenticated writes separate

In `src/server.ts:116-163`, `createWindowLimiter` caps the number of counters and discards the oldest key when it needs room. `clientLimiter` counts requests by client address. `operatorLimiter` tracks authenticated wiki writes with separate counters. Unauthenticated requests cannot displace the authenticated write counters.

### Limit the body before you check the signature

In `src/bounded-body.ts:16-35`, `readBoundedBody` refuses an oversized declared length before it reads. If the bytes received exceed the limit, it cancels the stream. In `src/routes/listener.ts:21-57`, `buildListenerRouter` returns 413 on refusal. For a body within the limit, it checks the signature against the unparsed text before it parses JSON.

## Why This Matters

The key counts requests. It does not authenticate a client. In `src/client-address.ts:87-94`, `accountingKey` groups IPv4 by address and IPv6 by network prefix (`/64`). In `src/client-address.ts:51-74`, `parseAddress` treats an IPv4 address carried in IPv6 format as IPv4. A body limit applied after buffering does not limit the memory used to read the body.

## When to Apply

When you change Caddy's proxy trust or header rules, make sure that the dashboard still receives only the forwarded values it expects. If the Docker network is recreated, make sure that the configured range still covers the Caddy peer. The dashboard ignores the header from a peer outside that range. See the [trusted proxy runbook](../../runbooks/trusted-proxy.md) for configuration details.

## Examples

In `test/client-address.test.ts:191-225`, the tests show that filling the client counter map does not reset the limit set by `consumeOperatorRateLimit`. In `test/listener-routes.test.ts:135-181`, the tests call `/api/listener/ingest`. They cover a declared length above the cap and a stream that crosses it without a declared length.

## Related

The [gateway OAuth lockout](../security-issues/gateway-operator-oauth-rate-limit-shared-key-behind-caddy-2026-09-21.md) documents the same shared-counter symptom in a different service.
