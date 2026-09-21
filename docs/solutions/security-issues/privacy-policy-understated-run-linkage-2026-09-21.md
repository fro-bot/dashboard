---
title: A vague word in one sentence made a false privacy claim in the next
date: 2026-09-21
category: security-issues
module: dashboard
problem_type: security_issue
component: documentation
severity: high
symptoms:
  - "A live public privacy policy states that operational records never include any repository or run detail"
  - "The upstream audit type documents the same field as the triggering run/approval id"
  - "The full suite is green: 3,150 tests, types, lint, and the design gate all pass"
  - "The claim that had been corrected during implementation has a pinning test; the claim that was wrong from the start has only a heading check"
root_cause: inadequate_documentation
resolution_type: documentation_update
tags: [privacy-policy, disclosure, audit-trail, correlation-id, claim-verification, false-green, test-coverage]
---

# A vague word in one sentence made a false privacy claim in the next

## Problem

The public privacy policy at `/privacy` told readers that operational records "never record an endpoint, key material, notification content, or **any repository or run detail**."

The last clause was false. A dispatch audit record's correlation identifier *is* the id of the run or approval that triggered the notification, so a dispatch record is linkable to the run that caused it. The page asserted the opposite, in production, on a compliance document.

## Symptoms

- `web/privacy.html` claimed no run detail is recorded.
- `fro-bot/agent@v0.113.2` `packages/gateway/src/web/audit.ts:249-256` types the field as `/** The triggering run/approval id */ readonly correlationId: string`, and `operator-push/dispatcher.ts:161` passes `dedupeId` into it.
- Every gate was green. 2,074 server tests, 1,076 web tests, types, lint, and the design check all passed with the false claim live.

## What Didn't Work

**Splitting one fact across two defensible sentences.** The claims artifact described the field as "a correlation identifier" and then, separately, asserted no run detail was recorded.

Each half survives inspection on its own. "Correlation identifier" is literally the field's name, and it reads as an opaque trace value. "No run detail" felt true because endpoints, keys and payloads genuinely are excluded. Composed, they publish a falsehood: the vague term concealed the specific thing, and the specific denial then sounded safe.

Nobody lied and no single sentence is indefensible. That is what makes this failure mode durable — reviewing either sentence alone finds nothing.

**Relying on a suite that was only guarding what had already been noticed.** An earlier claim on the same page had said the Gateway "sets no explicit TTL, urgency, or topic header." Technically true of the calling code, but `web-push@3.6.7` supplies defaults, so every request carries `TTL: 2419200` and `Urgency: normal` and relays observe them. That claim was corrected during implementation — and a pinning test was added in the same change.

The audit claim had only a heading-presence check, `audit: /what is logged/i`, in a category-coverage map. Nothing asserted the substantive disclosure.

So the claim that had been *corrected* was protected against regression, and the claim that was *wrong from the start* was not. **Adding a test when you correct something protects only the things you already noticed.**

**Trusting the original survey.** The page's content came from a careful source survey. It was still wrong. The error was not found by review or by tests — it was found by re-verifying every published claim against source a second time, adversarially, after the page was already live.

## Solution

State the linkage plainly, and keep the exclusions that are genuinely true:

```
These record the operator's account identifier, a coarse reason, a trigger label,
delivery counts, and an event kind. Dispatch records also identify the run or
approval that triggered the notification, so a dispatch record can be traced back
to the run that caused it. They never record an endpoint, key material,
notification content, or a repository name.
```

Changed in `web/privacy.html` and `web/src/privacy/claims.ts`.

### Pin the disclosure, not the sentence

```ts
it('discloses that a dispatch record identifies its triggering run', () => {
  expect(pageText).toMatch(/run or approval that triggered/i)
  expect(pageText).not.toMatch(/never record.{0,120}run detail/i)
})
```

Two deliberate choices. The positive assertion matches the *semantic* disclosure rather than the full sentence — pinning exact prose makes every copy edit a two-place change and leaves the test guarding the string it exists to protect. The negative assertion is what stops the old framing coming back.

### Prove the guard

A new test that passes proves nothing; it has never seen the bug. Restore the old wording into a scratch copy, run the test, and watch it fail:

```bash
# regressed copy of the page, current test file
cd /tmp/scratch && bun test content.test.ts   # or vitest, per project
```

Five failures, matching the original signature. Then restore the fix.

## Why This Works

The root cause was not a missing fact. It was a misleading composition of true facts.

The correct disclosure is not "no run detail exists." It is "the record excludes endpoint, key material, payload and repository name, **and** carries an identifier that links it to the triggering run." Privacy copy is judged by what a reader reasonably infers, not by whether each clause is individually defensible.

## Prevention

- **Correct a claim and pin it in the same change.** Otherwise you build an asymmetry where noticed problems are guarded and unnoticed ones are not — which is precisely the state that let this ship.
- **Prefer the concrete noun.** "A correlation identifier" hides what "the id of the run that triggered it" discloses. If a term makes a disclosure sound more innocuous than the thing it names, it is the wrong term.
- **Treat "technically true, materially misleading" as a defect**, not a nuance. In a disclosure document it is indistinguishable from false for the reader.
- **Check a claim's basis, not just its truth.** The TTL claim was accurate, but its evidence lived in a library default rather than the calling code, so only the pinned dependency version could settle it. A claim whose support is one layer away from where you looked is a claim you have not verified.
- **Verify against the deployed version.** Establish the deployed pin first — for this stack, `marcusrbrown/infra` `apps/gateway/upstream.json`, cross-checked against the live `/operator/health` `contractVersion`. Verifying against `main` proves something about a system nobody is running.
- **Re-verify published claims adversarially, after shipping.** Of twelve claims re-checked, eight were confirmed, two were narrower than described in ways that never reached the page, one was flagged and then vindicated, and one was wrong. The survey that produced them was careful, and careful was not enough.

## Related Issues

- [fro-bot/dashboard#502](https://github.com/fro-bot/dashboard/pull/502) — the correction, released `2026.09.14`.
- [fro-bot/dashboard#238](https://github.com/fro-bot/dashboard/issues/238) — the policy this page implements.
- `docs/solutions/integration-issues/public-route-swallowed-by-caddy-extensionless-rewrite-2026-09-20.md` — the other failure from this feature. Same page, unrelated cause: that one was about whether the page could be *reached*, this one about whether it was *true*.
- `docs/solutions/workflow-issues/unit-green-is-not-feature-done-verify-the-assembled-surface-2026-06-23.md` — the umbrella lesson. This is its content-truth case: the assembled surface rendered perfectly and said something false.
- `docs/solutions/workflow-issues/pwa-service-worker-registration-invisible-to-unit-tests-2026-06-25.md` — sibling false-green, at the runtime layer rather than the content layer.
