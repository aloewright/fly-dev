# fly-dev — Sandbox/microVM Readiness Review

**Goal reviewed against:** call a single Cloudflare dev worker via webhook → spin up sandboxed
containers on demand that run Claude Code / Codex to work on a git repo → open a PR → check off
the Linear task. Securely isolated, AI calls routed through Cloudflare AI Gateway (per CLAUDE.md).

**Method:** 61-agent multi-dimensional review (security, sandbox/containers, orchestration,
AI-gateway compliance, code quality). Every finding adversarially verified against the actual
code + Cloudflare runtime semantics (11 findings were rejected as misreadings/hypotheticals and
many severities were corrected). Grounded against current Cloudflare docs and the reference repos
(`vibesdk`, `sandbox-sdk` Claude Code example, `cloudflare-typescript`, `dynamic-workflows`).

---

## Bottom line

`fly-dev` is a **well-structured scaffold with a dead execution core.** The orchestration plumbing
is real and deploys — Hono router, D1 schema, OAuth + webhook signature verification, Queue →
Workflow → Container lifecycle, usage/approval tables, dispatch namespaces. But **the headline
capability — webhook → container → git → PR → Linear — is not wired anywhere.** The container is a
35-line no-op, `RunWorkflow` starts the box and stops, webhooks never create runs, and no
credentials ever reach the sandbox.

Two buckets, and conflating them is the main risk:

| Bucket | What it is | Action |
|---|---|---|
| 🔴 Exploitable-today bugs | Auth bypasses + silent data loss on the **live public** `dev.fly.pm` | Fix before *any* autonomous run |
| 🟡 Unbuilt pipeline | The whole agent execution path | Build to reach the goal (intentional v1 gaps; they fail *safe* today) |

Your architecture matches `cloudflare/vibesdk` (Cloudflare's own agent-builds-apps platform)
binding-for-binding — DO agents, Containers, **AI Gateway routing**, Workers-for-Platforms dispatch,
D1+Drizzle, R2, KV. You're on the right track; you just haven't built the engine.

---

## Architecture decision: Containers vs Sandbox SDK vs Dynamic Workers

- **Dynamic Workers can't run Claude Code.** They're V8 isolates — no `git`, no `node`, no `claude`
  binary, no filesystem. They're for running *LLM-authored tool snippets* (Code Mode). Keep them off
  the critical path. *Dynamic Workflows* (`@cloudflare/dynamic-workflows`) are a future option only if
  you ever want per-tenant orchestration loaded at runtime — not a v1 need; your static `RUN_WORKFLOW`
  is the right default.
- **Keep `@cloudflare/containers` for v1.** Your `SandboxContainer`, the DO migrations, and
  `RunWorkflow.startAndWaitForPorts` are load-bearing and deploy. The review agent agreed; migrating to
  the Sandbox SDK now is churn with no functional gain.
- **One correction to that recommendation (the agent didn't read the Sandbox SDK example; I did):** the
  Sandbox SDK's Claude Code example uses `interceptHttps = true` + `outboundByHost` to inject the model
  credential **at the sandbox boundary** — inside the container Claude only sees
  `ANTHROPIC_API_KEY=proxy-injected`, "sufficient to select the auth header but useless if exposed."
  **That is the clean answer to your AI-Gateway rule.** With raw `@cloudflare/containers` you don't get
  `interceptHttps`, so you must emulate it (egress allowlist + per-run token in the body, never baked
  into the image). If gateway-credential hygiene becomes the deciding factor, that's the one reason to
  reconsider adopting the Sandbox SDK.

---

## A. 🔴 Critical security — fix before any autonomous run

The worker is on `dev.fly.pm` as a **public `custom_domain` route with NO Cloudflare Access policy**
in `wrangler.jsonc`, so it does not strip or validate any of the headers below.

### A1 — Total user impersonation via forged headers `auth-session.ts:21-28` (critical, high-confidence)
`getCurrentUser()` trusts `x-fly-user` / `x-fly-email` / `x-fly-name` with zero verification. Any
client sends `x-fly-user: <victim-slug>` and becomes that user — create/approve/cancel runs, read all
their runs, connect OAuth. Reachable via the global middleware (`index.ts:42-46`) on every
`requireUser` route (`/api/tasks`, `/api/runs/:id/approve|cancel`, `/api/projects/:id/runs`,
`/api/integrations/:provider/connect`).
**Fix:** delete the `x-fly-*` path (it was built for a proxy that isn't deployed); rely on Better Auth
sessions or the HMAC internal path. If a proxy returns, put it behind Cloudflare Access and validate
the `cf-access-jwt-assertion` JWT.

### A2 — Internal API bypass via forged `cf-access-authenticated-user-email` `auth-session.ts:59-61` (critical)
`verifyInternalRequest()` returns `true` if that header is merely *present* — no value check, no JWT
validation — and it short-circuits *before* the correct HMAC path. `/api/internal/summon` →
`createTaskRun()` is wide open to any anonymous caller. (Found independently by 5 of the reviewers.)
**Fix:** validate the CF Access JWT against `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`
(check `aud`/`iss`/`exp`), **or** drop the header shortcut and rely only on the HMAC
(`INTERNAL_API_SECRET`) path, which is already correct.

### A3 — Dev fallback trusts the `Host` header `auth-session.ts:31-45` (critical)
The "localhost → auto-login as Local Dev" branch is OR-joined on the caller-controlled `Host` header
(`hostHeader.startsWith("localhost:")`), with no `APP_ENV` guard. A request to `dev.fly.pm` with
`Host: localhost:8787` is granted a valid `CurrentUser`.
**Fix:** gate on `env.APP_ENV !== "production"` (the var is already set), not on a request header.

### A4 — Unauthenticated AI endpoints = open cost faucet `index.ts:159, 196` (high)
`GET /api/ai/ping` and `POST /api/ai/chat` have **no** `requireUser`/`verifyInternalRequest` guard
(the conspicuous exception among all routes) and forward arbitrary messages to `env.AI.run()` —
anyone burns your Workers-AI / gateway budget, and `maxTokens` is uncapped server-side.
**Fix:** add `requireUser` (or delete them — they're smoke tests); clamp `maxTokens` (e.g. ≤2048);
stop returning the raw gateway `response` object.

### A5 — `slugify()` collisions merge accounts `auth-session.ts:119-126` (high)
`slugify()` strips the email domain, so `john.smith@company.com` and `john.smith@evil.com` both →
`john-smith`. `ensureUser` upserts `ON CONFLICT(fly_user_slug)`, so the second login **overwrites the
first user's row** (and, combined with A1, lets a forged `x-fly-user` resolve to a victim's real
account). **Fix:** use the Better Auth user ID as the slug, or append a short hash of the full email.

### A6 — Tokens silently lost when `TOKEN_ENCRYPTION_KEY` unset `crypto.ts:27` + `integrations.ts:77` (medium)
`encryptText()` returns `null` when the key is absent; the OAuth callback stores `NULL` tokens with no
error and a successful redirect. **Fix:** fail-fast — throw if `TOKEN_ENCRYPTION_KEY` is missing at
token-store time (ideally a startup required-secrets check).

### A7 — Webhook body persisted before signature check `index.ts:312-327` (medium)
`storeWebhook()` runs *before* the `signatureValid` 401 gate, so any internet client writes
arbitrary-length JSON into `webhook_events` (storage-exhaustion / cost-amplification DoS).
**Fix:** move `storeWebhook()` after the gate (or store only a truncated hash for rejected events);
cap body size.

### A8 — AES-GCM key derivation / rotation `crypto.ts:22-25` (low)
Key = raw `SHA-256(secret)` (no KDF/salt — acceptable for a high-entropy random secret) but **shared
across all users/providers with no rotation path** (rotating the key bricks all existing ciphertexts).
**Fix:** add a key-version prefix (`v1.<iv>.<cipher>`) so a new key can be introduced without breaking
old reads.

---

## B. 🔴 Correctness bugs (independent of the missing features)

### B1 — Silent data loss: the `D1_ERROR` swallow `data.ts:339` (+ `auth-session.ts:97`) (critical)
`isMissingTableError` matches `/no such table|D1_ERROR/i`, but **`D1_ERROR` is the generic prefix D1
puts on *most* runtime errors** (per Cloudflare's "Debug D1" docs). So `runSql()` swallows real
NOT-NULL / type / SQL failures on the app's write paths (`runs`, `approvals`, `usage_events`,
`run_events`, `account_connections`) and returns success — silent degradation with no log. The same
regex at `auth-session.ts:97` degrades any D1 error to an unauthenticated (null) session.
**Fix:** narrow to `/no such table/i` (a missing table is still `"D1_ERROR: no such table: …"`, so it's
still caught); or run migrations and stop swallowing. (Verifier note: not *every* INSERT — Better
Auth writes via its own adapter — but all orchestration/usage writes are affected.)

### B2 — Workflow duplicate-instance / status clobber `orchestration.ts:149` + `index.ts:566` + `approveRun:79-96` (medium)
`RUN_WORKFLOW.create({ id: runId })` throws "instance already exists" if re-created within the
retention window (`create()` is not idempotent; `createBatch()` is). The **deterministic trigger** is
`approveRun` having **no idempotency guard** (its UPDATE has no status filter), so calling
`POST /api/runs/:id/approve` twice enqueues two `start-run` messages; the second `create()` throws, the
catch calls `markRunFailed`, and a run whose Workflow is actually running gets clobbered to `failed`.
Bounded by `max_retries: 3` → DLQ (not an infinite loop). **Fix:** guard `approveRun` with a
status filter; before `create()`, check `RUN_WORKFLOW.get(runId)` and `ack` (not retry) on
already-exists.

### B3 — `REQUIRE_HUMAN_APPROVAL` is a dead kill-switch `orchestration.ts:29` (medium)
Set `"true"` in `wrangler.jsonc`, declared in `Env`, **never read.** Approval keys only off
client-supplied `payload.autonomyMode`. Webhook-triggered runs arrive with no `autonomyMode`. An
operator who sets this expecting a global gate is silently ignored — dangerous once mutations are
wired. **Fix:** `approvalRequired = env.REQUIRE_HUMAN_APPROVAL === "true" ? 1 : (autonomyMode === "auto_eligible" ? 0 : 1)`.

### B4 — No webhook dedup `integrations.ts:134` / schema (medium)
`webhook_events.event_id` has no UNIQUE constraint and `storeWebhook` always INSERTs a fresh row.
GitHub retries (and, once wired, run dispatch) will process the same delivery multiple times.
**Fix:** `CREATE UNIQUE INDEX … ON webhook_events(provider, event_id) WHERE event_id IS NOT NULL`;
`INSERT OR IGNORE`; only dispatch when the insert actually wrote a row.

### B5 — Lower-severity bugs (verified, low)
- **Queue consumer drops `sync-project`/`deploy-page`** (no `ack`/`retry`) → redelivery → DLQ. Latent
  (no producer emits them yet). `index.ts:549` — add an `else { …ack() }`.
- **`JSON.parse(body)` in the Linear webhook has no try/catch** → 500 (only reachable post-HMAC, so not
  externally exploitable). `index.ts:324` — wrap and return 200.
- **`/api/tasks` doesn't guard `c.req.json()`** → 500 on malformed body (authenticated only).
  `index.ts:266` — `.catch(() => null)` → 400. Apply to `/templates/apps`, `/internal/summon`,
  `/internal/pages-deploy`.
- **`OWNER_REPO_PATTERN` false positives** — matches `src/index`, `api/v2`, etc. as repo candidates at
  0.55 (written as `needs_review`, excluded from the active join, so impact is noise).
  `repo-mapping.ts:12` — blocklist common path tokens / require username-shaped owner.
- **`approveRun` omits `projectId`** → the one `container_runtime` usage row gets `project_id=NULL`
  (cost-attribution gap, not a UI-linkage break). `orchestration.ts:94`.

---

## C. 🟡 The missing pipeline (this is the goal)

These are *intentional v1 gaps* (the code says "Human-safe v1 stops before mutating repositories" and
fails safe — no fake PRs, no leaked tokens). They're exactly what must be built.

1. **Webhook → run is unwired** `index.ts:306-328`. Linear webhooks only sync a project; GitHub
   webhooks are stored and ignored. Nothing calls `createTaskRun()`. *Your entry point never fires.*
2. **`RunWorkflow` stops at "ready"** `index.ts:495-537`. Starts the container, records the handoff,
   returns `ready_for_execution`. Never POSTs the objective, never clones, never PRs, never touches
   Linear. (Also: `markRunSucceeded` doesn't exist and runs sit in `running` forever — add a terminal
   state.)
3. **`container/server.mjs` `/run` is a no-op** `server.mjs:13-28` — returns 202, discards the body.
4. **No credentials reach the container** `index.ts:475-493`. `envVars` has only `NODE_ENV`/
   `FLY_DEV_SANDBOX`. (Don't put secrets there — they're baked into the class and shared across
   instances. Pass per-run in the POST body.)
5. **No AI-Gateway routing in the container.** Once the CLI is wired it will hit `api.anthropic.com`
   directly (violating CLAUDE.md, and that host isn't in `allowedHosts` so it'd also be blocked).
6. **Dockerfile gaps** `container/Dockerfile`: `node:22-slim` has **no `git`** (clone fails); CLIs are
   unpinned (`npm i -g …` resolves `latest` → non-reproducible/supply-chain); runs as **root** (no
   `USER`); cosmetic `WORKDIR /workspace` vs `/app` split (works, but tidy it).
7. **Container is under-provisioned.** No `instance_type` set → defaults to **`lite` (1/16 vCPU, 256 MiB,
   2 GB disk)** — too small for clone + node CLIs. Use **`standard-2`** (1 vCPU / 6 GiB / 12 GB) or a
   custom type.
8. **Vestigial DOs** `ProjectConductor`, `UserWorkerController`, `DevOrchestratorAgent` aren't on the
   critical path — wire or prune deliberately (they consume migration slots).

---

## D. ✅ Verified compliant (no action)

- **`runAi()` worker-side** `index.ts:96-108` exactly matches the sanctioned CLAUDE.md exception
  (`env.AI.run("@cf/openai/gpt-oss-120b", …, { gateway: { id } })`), with a comment pointing at the rule.
- **No direct provider SDK / API URLs** anywhere in `worker/src` (grep clean).
- `recordRunEvent` INSERT is structurally correct (relies on AUTOINCREMENT).

---

## E. Rejected by adversarial verification (don't chase these)

- **`upsertRepositoryMapping` "ON CONFLICT never fires"** — *false.* The `provider` column default
  `'github'` satisfies `UNIQUE(linear_project_id, provider, owner, repo)`; upsert works.
- **Cross-user container state leak** — *moot.* No agent runs yet; nothing is written into the box.
- **"Claude calls api.anthropic.com directly"** (raised by 5 agents) — *false today.* The entrypoint is
  `node server.mjs`, not the CLI; the CLIs are never invoked. Becomes real only when you wire §C.
- **`approveRun` ownership check** — already scoped via `WHERE id=? AND user_id=?`.
- **`max_instances:10` / 30s boot "misconfigured"** — premises false (no monorepo clone, no runtime
  `npm install` in current code).

---

## F. Build blueprint (condensed, with corrections)

**New `RunWorkflow` steps** (replace the "record handoff" stub):
`resolve credentials` → `start container` (exists) → `dispatch to container` (POST objective + creds,
await result, store `pr_url`/`commit_sha`) → `linear write-back` → `mark run done`. Clone/agent/PR run
**in the container**; credential exchange and Linear write-back are **durable Workflow steps**.

**Credential plumbing (security-critical):**
- **GitHub:** don't hand the broad OAuth token (`repo workflow read:org`) to an LLM sandbox. In a
  Workflow step, exchange it for a **GitHub App installation token** scoped to the single repo
  (`contents:write`, `pull_requests:write`), 1-hour TTL. Pass it **per-run in the POST body**, never in
  `envVars`. (Adds `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` secrets.)
- **AI Gateway:** point the CLI at the gateway, secret-free in the container. ⚠️ **Correction to the
  agent blueprint:** Claude Code speaks the **Anthropic Messages** format, so `ANTHROPIC_BASE_URL` must
  target the gateway's **Anthropic passthrough** (`…/v1/{acct}/x/anthropic`), *not* the OpenAI-shaped
  `/compat/chat/completions`. Cleanest hygiene is the **`interceptHttps`** pattern (host-side proxy
  injects `cf-aig-authorization`) so the token never enters the box. Add `objects.githubusercontent.com`
  + `codeload.github.com` to `allowedHosts` for clone. Add `CF_AIG_TOKEN` secret.
- ⚠️ **Correction:** `wrangler.jsonc` can't mix a named `instance_type` with `disk_mb`. Use **either**
  `"instance_type": "standard-2"` **or** a custom object
  `{ "vcpu": 1, "memory_mib": 6144, "disk_mb": 12000 }` (custom requires ≥1 vCPU, ≥3 GiB RAM/vCPU,
  ≤2 GB disk per GiB RAM).

**In-container `/run`:** validate body → `git clone --depth=1` with
`https://x-access-token:{token}@github.com/{o}/{r}.git` → branch `fly-dev/{runId}` → bot git identity →
`claude --print --allowedTools "Edit,Write,Bash(git …:npm:node)" --max-turns N "{objective}"` (gateway
env set, ~8-min timeout) → bail if no diff → commit/push → open PR via `POST /repos/{o}/{r}/pulls` →
return `{ ok, prUrl, prNumber, branch, commitSha, diff, summary, logs }` → `rm -rf` workspace.

**Linear write-back** (Workflow step, non-fatal on error): `commentCreate` (PR link) →
`attachmentCreate` (PR attachment) → query the team's `completed` `workflowStates` →
`issueUpdate(stateId)`. Store `linearIssueId`/`teamId` from the webhook payload into
`runs.metadata_json`.

**Schema/migration `0002`:** add `pr_url`, `commit_sha`, `branch_name`, `linear_issue_id`,
`linear_team_id` to `runs`; add the `UNIQUE(provider, event_id)` index on `webhook_events`.

**Webhook triggers:** Linear `Issue` `update` where `state.type` → `started` (or a label); GitHub
`issue_comment` containing `/claude`. Dedup on `event_id`, then `createTaskRun()`.

**Use `cloudflare-typescript`** (`new Cloudflare({ apiToken })`, runs inside Workers) for the
dispatch-namespace deploy / container management path — your `CLOUDFLARE_API_TOKEN` is declared but
currently unused; don't hand-roll those API calls.

---

## G. Reference implementations to mine

- **`cloudflare/vibesdk`** — closest production analog (agent builds + deploys apps in sandboxes); same
  primitives you have, with the execution layer built and AI Gateway routing (`CLOUDFLARE_AI_GATEWAY_TOKEN`).
- **`cloudflare/sandbox-sdk` → `examples/claude-code`** — the `interceptHttps`/`outboundByHost`
  credential-injection + `gitCheckout`/`exec` + diff/logs contract.
- **`cloudflare/cloudflare-typescript`** — Workers-compatible API SDK for dispatch/containers/etc.
- **`cloudflare/dynamic-workflows`** — only if you later want per-tenant runtime-loaded orchestration.

---

## H. Recommended sequence

1. **Land the security fixes first** — A1–A4 and B1 (live exploits + silent data loss), plus B3 (dead
   safety gate). Nothing autonomous should run until these are closed.
2. **Wire the happy path behind the approval gate** — §C items 1–7: webhook→run, the new `RunWorkflow`
   steps, the real `server.mjs`, Dockerfile `git`, instance sizing, gateway routing.
3. **Harden** — least-privilege GitHub App token, `interceptHttps`/proxy for the gateway secret,
   webhook dedup (B4), the lower-severity B5 items, observability.

---

### Appendix — Container instance types (current CF limits)

| Type | vCPU | Memory | Disk |
|---|---|---|---|
| lite (default) | 1/16 | 256 MiB | 2 GB |
| basic | 1/4 | 1 GiB | 4 GB |
| standard-1 | 1/2 | 4 GiB | 8 GB |
| **standard-2 (recommended)** | 1 | 6 GiB | 12 GB |
| standard-3 | 2 | 8 GiB | 16 GB |
| standard-4 | 4 | 12 GiB | 20 GB |

Custom: `{ vcpu, memory_mib, disk_mb }` — ≥1 vCPU, ≥3 GiB RAM/vCPU, ≤2 GB disk per GiB RAM.
