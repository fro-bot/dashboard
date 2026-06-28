---
date: 2026-06-27
topic: operator-local-development-harness
---

# Operator Local Development Harness

## Summary

This work has two tracks. Track 1 is an urgent dashboard contract-drift repair so live operator streams at contract `1.5.0` render status and output again. Track 2 is a follow-on local operator-development harness that gives dashboard changes a same-origin, fixture-backed Gateway loop before they reach production.

---

## Problem Frame

A live dashboard-launched run can be created and streamed, but the current dashboard refuses to render it because the Gateway stream advertises operator contract `1.5.0` while the dashboard consumer is pinned to `1.4.0`. The fail-closed behavior is correct, but the pin stayed stale and reached production.

The previous monitoring UI had a local testing posture that made frontend iteration possible without waiting for infrastructure deploys. The operator-first PWA needs an equivalent fast loop for current Gateway-shaped traffic, without reopening monitoring as a fallback and without turning the production dashboard into an operator API proxy.

---

## Terms

- **Same-origin local harness:** A loopback development composition where the browser sees one origin for `/`, assets, service worker files, and fixture-backed `/operator/*` routes. This can be achieved by a dev-only composition layer, but production dashboard builds must still not serve or proxy real Gateway operator APIs.
- **Fixture-backed Gateway behavior:** Synthetic or sanitized replay behavior that matches Gateway wire shapes closely enough to exercise the dashboard's real browser parser and runtime path.
- **Real local Gateway path:** A separate, gated follow-up path for running `fro-bot/agent` locally or in a containerized same-origin composition. It is not required for the first harness slice.

---

## Actors

- A1. Operator: Launches and observes Fro Bot runs through the dashboard PWA.
- A2. Dashboard developer: Iterates on operator UI, contract parsing, and PWA behavior locally.
- A3. Gateway provider: Publishes the operator contract and serves browser-direct `/operator/*` routes.
- A4. Planner or reviewer: Uses this document to keep drift repair separate from harness work.

---

## Key Flows

- F1. Live drift repair
  - **Trigger:** A Gateway stream sends `ready` with contract `1.5.0` and subsequent `status` or `output` frames.
  - **Actors:** A1, A3
  - **Steps:** Dashboard verifies the `1.4.0` to `1.5.0` consumed-surface diff, accepts the known current contract, renders safe run state, and displays streamed output while preserving fail-closed behavior for unknown future versions.
  - **Outcome:** The current live run stream no longer appears as a version-mismatch blank surface.
  - **Covered by:** R1, R2, R3, R4, R5
- F2. Fixture-backed local operator loop
  - **Trigger:** A dashboard developer starts local dashboard verification without access to the live infra-bound Gateway.
  - **Actors:** A2
  - **Steps:** The local composition serves the operator PWA and fixture-backed `/operator/*` behavior from one browser origin, launches a synthetic run, streams `ready`, `status`, and `output` frames over the same wire parser path as production, and supports explicit drift and failure scenarios.
  - **Outcome:** Contract, stream, output, routing, and PWA behavior can be verified before deploy.
  - **Covered by:** R6, R7, R8, R9, R10, R11
- F3. Optional higher-fidelity Gateway exploration
  - **Trigger:** A change cannot be validated with fixture-backed behavior because it depends on real Gateway auth/session or engine behavior.
  - **Actors:** A2, A3
  - **Steps:** The developer evaluates a local `fro-bot/agent` Gateway path against explicit fidelity gates before treating it as a verification source.
  - **Outcome:** Higher fidelity is pursued only when it exercises production-relevant behavior rather than greenlighting a divergent shim.
  - **Covered by:** R12, R13

---

## Requirements

**Track 1 — urgent contract drift repair**
- R1. Dashboard must support the current Gateway operator contract `1.5.0` for both its TypeScript stream reader and browser runtime consumer.
- R2. The repair must diff the `1.4.0` to `1.5.0` consumed surface and enumerate every consumed event, field, and semantic rule covered by dashboard tests.
- R3. Contract pins must remain strict allowlists: unknown contract versions render a non-interactive drift state and do not partially apply status, output, approval, or future frames.
- R4. The `1.5.0` repair must include output-frame coverage so the observed case of `ready`, `status`, and `output` renders visible output.
- R5. The browser runtime pin and vendored contract pin must be verified in lockstep so they cannot drift silently.

**Track 2 — fixture-backed local harness**
- R6. The dashboard must have a documented local operator mode that runs on loopback and presents one browser origin for the app shell, service worker, static runtime assets, and fixture-backed `/operator/*` routes.
- R7. In fixture mode, route ownership must be explicit: the dashboard app owns `/`, `/operator` canonicalization, static assets, and the service worker; the fixture harness owns operator data routes such as session, CSRF, repo list, launch, and run stream.
- R8. The fixture harness must never forward live operator requests or real credentials to production Gateway origins, even in dev mode.
- R9. Fixture mode must use synthetic local identities and mocked session/CSRF state only; it must never accept, mint, store, or replay real dashboard or Gateway cookies, bearer tokens, OAuth credentials, or CSRF secrets.
- R10. Fixture streams must exercise the same wire-format parser and browser runtime path as production, including success, contract drift, malformed or partial frames, rate limiting or unavailable states, first-frame delay, offline behavior, and streamed output text.
- R11. Fixture artifacts must be sanitized or synthetic before storage and render. They must not contain secrets, private repository names, account identifiers, run IDs from real systems, workspace paths, timing traces, internal URLs, cookies, CSRF values, tokens, prompts, tool arguments, raw error payloads, or private workflow metadata.

**Track 3 — optional real Gateway path**
- R12. A real local `fro-bot/agent` Gateway mode is deferred until a planning pass proves which topology can satisfy Gateway's current constraints: no loopback bind, HTTPS public origin, OAuth client configuration, CSRF secret, and return-path allowlisting.
- R13. If a real Gateway mode is pursued, it must use local-only credentials and secrets with documented storage, rotation, and environment isolation; production OAuth and CSRF material must not be reused.
- R14. The real Gateway mode is exploratory unless it exercises production-relevant auth/session behavior; shims that bypass the behavior under test cannot be used as release verification evidence.

**Operator UI and verification behavior**
- R15. The operator PWA must keep one launch-to-observe surface: the initial landing view exposes launch controls, run status, and output without sending the operator to a separate monitoring surface.
- R16. Streamed output must render as plain text, preserve arrival-order accumulation semantics, handle empty or delayed output distinctly from failure, and remain bounded so large output cannot lock the page.
- R17. Failure states must be user-visible and consistent: contract drift is non-interactive, rate limiting and unavailable states offer retry guidance, first-frame delay keeps the run as submitted-but-not-observable, and offline mode preserves safe shell navigation without pretending live data is current.
- R18. Local browser verification must cover observable behavior: root load, `/operator` canonicalization, refresh/reconnect, service worker takeover, offline `/operator`, runtime module loading, output rendering, and contract-drift detection.

---

## Acceptance Examples

- AE1. **Covers R1, R2, R4.** Given a stream that starts with `ready` contract `1.5.0`, when status and output frames arrive, the operator UI displays the run state and output text through the production parser path.
- AE2. **Covers R3.** Given a stream that starts with a future unsupported contract, when later status or output frames arrive, the UI remains in a safe drift state and does not render guessed run data.
- AE3. **Covers R6, R7, R10.** Given no access to the live Gateway, when a developer starts fixture mode, the dashboard can launch a synthetic run and observe fixture status plus output frames from the same browser origin.
- AE4. **Covers R8, R9.** Given fixture mode is running, when any fixture route would need a credential, it uses only synthetic localhost-scoped state and never forwards or accepts real Gateway credentials.
- AE5. **Covers R11.** Given a proposed fixture artifact, when it is reviewed for commit, no real operator-visible identifiers, prompts, tool payloads, private paths, internal URLs, tokens, cookies, timing traces, or private workflow metadata remain.
- AE6. **Covers R12, R13, R14.** Given a proposed real local Gateway mode, when it cannot exercise production-relevant auth/session behavior without unsafe secret reuse or bypass shims, it is documented as exploratory and excluded from release verification.
- AE7. **Covers R15, R16, R17, R18.** Given the local harness is running, when browser verification opens `/`, navigates to `/operator`, reloads under service worker control, tests offline `/operator`, and streams output plus drift fixtures, each observable state matches the operator-first PWA behavior.

---

## Success Criteria

- Operators can see live contract `1.5.0` stream status and output in the dashboard.
- Dashboard developers can complete launch-to-observe locally without infra access or a `marcusrbrown/infra` session.
- Contract drift is detected during normal local verification before production deploy.
- Local operator UI iteration no longer waits on infra deploys for parser, output, routing, and PWA behavior.
- The production no-dashboard-proxy invariant remains intact and testable.

---

## Scope Boundaries

- Do not restore or relocate the monitoring UI as a local-testing fallback.
- Do not make contract-version mismatches permissive.
- Do not add production dashboard routes that proxy real Gateway operator APIs.
- Do not solve the full local Gateway OAuth/session story in the first fixture-backed slice.
- Do not use raw live captures as fixtures; only sanitized or synthetic artifacts are allowed.
- Do not treat tier-2 real Gateway exploration as release verification until its auth/session fidelity gates are met.

---

## Key Decisions

- **Two tracks, not one shipment:** The live drift repair is urgent and should not wait for the harness. The harness is follow-on prevention and developer leverage.
- **Fixture replay is tier 1:** It gives the dashboard a fast, deploy-independent feedback loop without fighting Gateway's production-grade local bind and OAuth constraints.
- **Real Gateway mode is gated:** Higher fidelity matters only if it exercises production-relevant behavior; otherwise it is a misleading green check.
- **Same-origin shape is required:** The harness must make the browser experience one origin locally while production dashboard routes remain absent for real operator APIs.
- **Fail-closed remains the contract rule:** Supporting `1.5.0` means bumping known pins and covering consumed semantics, not weakening mismatch handling.

---

## Dependencies / Assumptions

- The pinned `fro-bot/agent` source currently advertises operator contract `1.5.0` and emits that value in the run-stream `ready` frame.
- The current Gateway production configuration is not laptop-local friendly: it rejects loopback binds and expects HTTPS public-origin OAuth configuration.
- The dashboard already has dev autologin and no-watch loopback browser verification patterns that can be reused for local harness verification.
- Only sessions from the `marcusrbrown/infra` operational context can currently reach the live Gateway operator, so dashboard-local development cannot depend on that path.

---

## Outstanding Questions

### Resolve Before Planning

- [Affects R1-R5][Technical] What changed from operator contract `1.4.0` to `1.5.0`, and which consumed fields, events, and semantics must dashboard tests cover?
- [Affects R6-R10][Technical] What is the smallest local composition that gives the browser one loopback origin while keeping fixture operator routes outside the production dashboard app?

### Deferred to Planning

- [Affects R10][Technical] What fixture format should represent SSE streams so output, reconnect, drift, malformed-frame, and failure cases stay easy to author and review?
- [Affects R11][Security] What automated fixture-sanitization check should block committed raw operator captures?
- [Affects R12-R14][Needs research] Which local `fro-bot/agent` topology, if any, can satisfy auth/session fidelity without unsafe secret reuse or misleading shims?

---

## Sources / Research

- `src/gateway/operator-contract/version.ts` — current dashboard vendored contract pin.
- `public/operator-stream.js` — browser runtime contract pin and drift behavior.
- `src/gateway/operator-sse-reader.ts` — TypeScript stream reader contract gate.
- `.slim/clonedeps/repos/fro-bot__agent/packages/gateway/src/operator-contract/version.ts` — pinned Gateway contract version.
- `.slim/clonedeps/repos/fro-bot__agent/packages/gateway/src/web/sse/run-stream-route.ts` — Gateway emits contract version in the `ready` frame.
- `.slim/clonedeps/repos/fro-bot__agent/packages/gateway/src/config.ts` — local Gateway bind, public-origin, OAuth, CSRF, and allowlist constraints.
- `docs/solutions/best-practices/operator-sse-output-consumption-2026-06-22.md` — contract drift must fail closed, and pins must move in lockstep.
- `docs/solutions/best-practices/safe-operator-launch-surface-2026-06-20.md` — dashboard must not proxy production operator routes.
- `docs/solutions/best-practices/operator-first-pwa-routing-and-fail-states-2026-06-26.md` — browser verification and operator-first PWA routing rules.
