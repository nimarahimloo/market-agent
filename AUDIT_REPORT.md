# Deep-Dive Review — market-agent-command-center

Date: 2026-10-21 · Branch: `fix/audit-reviewer-bugs` · PR: https://github.com/nimarahimloo/market-agent-command-center/pull/1

## Verdict

Solid codebase overall: typecheck clean, 86/88 tests passing, paper-only invariants consistently enforced (`MARKET_POLICY.liveTradingEnabled: false`), read-only wallet handling with no private keys, append-only audit log, owner-scoped data isolation via `ownerScoped()`. Four confirmed bugs found and fixed.

## Bugs fixed

### 1. Nondeterministic audit event returned (`server/db.ts`)

`appendAuditEventToDb` inserted an audit row, then selected **all** of the owner's rows with **no `ORDER BY`** and returned `rows[rows.length - 1]`. MySQL/InnoSQL does not guarantee result ordering without `ORDER BY`, so callers could silently receive an older event instead of the one just appended — corrupting audit-linked flows (paper alerts, opportunity updates, watchdog events).

**Fix:** `ORDER BY id DESC LIMIT 1`, scoped to `ownerId`.

### 2. Legitimate 0% price reaction dropped (`shared/marketReaction.ts`)

`calibrateSurpriseSeverity` guarded with `!observed?.returnPct`. A real 0% post-release move (flat price) is falsy, so genuine observations were classified `unavailable` instead of being compared against the standardized surprise — biasing the surprise-calibration sample.

**Fix:** only `null`/`undefined`/`NaN` reactions are unusable; a true 0% reaction now correctly reports `contradicted` (or `aligned` when z = 0). Regression test added in `server/marketReaction.test.ts`.

### 3. Flat-file upload ignored column mapping (`server/_core/index.ts`)

`/api/flat-files/upload` hardcoded an empty mapping into `parseFlatFileChunks`. Any CSV whose headers differ from the lowercase defaults (e.g. `Date,Open,High,Low,Close,Volume`) had every row rejected and the dataset persisted as `rejected`.

**Fix:** optional `X-Flat-File-Mapping` JSON header (validated as an object of column names), forwarded to the parser which already merges it over defaults. Existing clients that omit the header are unaffected.

### 4. Watchdog wallet staleness check was a no-op (`server/watchdog.ts`)

`runWatchdog` called `markWalletHeartbeat()` (stamps `lastHeartbeatAt = now`) and then evaluated `evaluateHeartbeat(new Date(), now)` — always "fresh". A silently stuck wallet monitor could never be flagged degraded/stale.

**Fix:** capture the previous `lastHeartbeatAt` before refreshing and evaluate staleness against that pre-refresh timestamp.

## Verification

| Check | Result |
|---|---|
| `pnpm check` (tsc --noEmit) | Clean, zero errors |
| `pnpm test` | 86/88 passing |
| 2 failing tests | Pre-existing, env-only: require `MASSIVE_API_KEY` (`server/massive.api.test.ts`, `server/massiveData.test.ts`) |

## Notes / follow-ups (not bugs, not changed)

- The repo's `pnpm-lock.yaml` pins `wouter@3.7.1` for `patches/wouter@3.7.1.patch`, but `package.json` declares `^3.3.5`. If the lockfile is ever deleted/regenerated, the patch silently stops applying. Consider pinning the exact version in `package.json`.
- A local install quirk surfaced during review: `patches/wouter@3.7.1.patch` requires the resolved version to be exactly 3.7.1.
- The 2 Massive API tests fail loudly when `MASSIVE_API_KEY` is unset; consider skipping them gracefully when the key is absent so CI stays green.
