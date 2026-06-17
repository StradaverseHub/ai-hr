# ADR-0023 — Multi-provider AI configuration (per-tenant BYOK, encrypted at rest)

Status: **Accepted** (building) · Date: 2026-06-17 · Builds on [ADR-0007](0007-ai-native-architecture.md), [ADR-0022](0022-performance-phase-b.md)

## Context

ADR-0022 slice 5 shipped "Draft with AI" on the manager review through a single governed gateway
(`lib/ai`), wired to one provider (Anthropic) with the key read from a server env var. The owner then
asked for a configuration surface: choose **which LLM/provider and model** to use and **enter the API
key** in-app. Two forks were resolved with the owner: support **multiple providers** (Anthropic +
OpenAI + Google), and store the key **in-app, encrypted** (not env-only).

That turns a one-provider env switch into a multi-tenant secrets-management feature. A pre-implementation
adversarial security review flagged that this codebase has **no `FORCE ROW LEVEL SECURITY`** anywhere and
that the cluster's **default privileges grant the app role table-wide SELECT** on new tables — so a naive
"write-only column" would still be dumpable, and an owner-role connection (seeds, scripts, studio) would
bypass RLS entirely. Encryption at rest is meaningless against either hole.

## Decision

A per-tenant **BYOK** model with a platform env fallback, behind the existing gateway.

**Provider abstraction (`lib/ai/`).** `lib/ai.ts` became a package: `types.ts` (the `AiAdapter`
interface + `AiGatewayError`), `providers/{anthropic,openai,google}.ts` (one adapter each), `registry.ts`
(model lists + env-fallback resolution), `crypto.ts` (AES-256-GCM), and `index.ts` (dispatch +
`redactPII`). Adapters **construct their client per call** from the resolved key — never a module-scope
singleton (which in a per-tenant-key design would serve tenant B with tenant A's key). Provider SDK
errors are mapped to a **generic** `AiGatewayError` so no key fragment or raw provider body reaches a log,
a server-action return, or the browser.

**Secret-at-rest (`lib/ai/crypto.ts`).** AES-256-GCM, fresh 12-byte IV per encryption, 16-byte tag; the
32-byte key is derived from `AI_CONFIG_SECRET` via **scrypt** (fixed app salt) and cached. The **tenant
id is the GCM AAD**, so a ciphertext is not portable across tenants (a row copied/restored into another
tenant fails to decrypt — a hard error, not a usable key). Missing/short secret → `isSecretStorable()`
false and encrypt/decrypt throw (fail closed; the build and tests never need it).

**Data + RLS (`ai_provider_config`, migration 0059).** One row per `(tenant, provider)`: model, encrypted
key, `key_last4`, `is_active`. The security controls, all in the RLS migration:
- **`FORCE ROW LEVEL SECURITY`** — the first forced table in the codebase. The owner role no longer
  bypasses RLS for this table, so seeds/scripts/studio can't dump every tenant's ciphertext.
- **The app role is never granted `SELECT` on `api_key_ciphertext`** (the table-wide default SELECT is
  `REVOKE`d, then non-secret columns re-granted per column). The ciphertext is read **only** through
  `app.ai_active_provider_config()`, a `SECURITY DEFINER` resolver that returns the active row for the
  current tenant (FORCE-RLS-scoped, search_path-pinned). "Write-only key" is a privilege fact, not a
  coding-discipline hope.
- **Writes are admin-only** (RLS `WITH CHECK app.is_admin()`, plus `assertAdmin` in the service and
  `requireAdmin` on the route). **Reads are tenant-scoped** (the resolver must work for a non-admin
  manager generating a draft). **One active provider per tenant** (partial-unique index;
  deactivate-then-activate in one tx).

**Resolution precedence.** Active tenant config (decrypt with tenant AAD) → platform env fallback
(`envFallbackConfig`) → off. **Fail closed:** a present-but-undecryptable tenant config errors; it does
**not** fall through to the shared platform key (which would bill/route a tenant's PII through the
platform's own account).

**Draft path unchanged in contract.** `draftManagerReview` resolves the config inside its gather tx
(decryption is CPU only), calls the provider **outside** any tx, **redacts PII for every provider**, stays
draft-only and manager-gated, and audits with a key-free event (`{cycleId, provider, model}`).

**UI.** `/admin/ai` (admin-only): a card per provider — model dropdown, write-only key field (shown as
`••••last4`), Test connection (generic ok/fail), Save, and which provider is active. i18n across all 6
locales. Gated on `isSecretStorable()` so keys can't be entered with no master secret set.

## Consequences

- New deps: `openai`, `@google/genai`. New env: `AI_CONFIG_SECRET` (required to store keys), optional
  `OPENAI_API_KEY` / `GOOGLE_API_KEY` platform fallbacks (alongside the existing `ANTHROPIC_API_KEY`).
- **Single-secret blast radius:** one `AI_CONFIG_SECRET` decrypts every tenant's key. The AAD stops
  cross-tenant *replay*, not a leaked master secret. Rotating it makes stored keys unrecoverable
  (re-enter). A KMS/per-tenant-DEK envelope scheme is the future hardening if the threat model warrants.
- **PDPA note:** drafts send *redacted* review context to a tenant-chosen third party; `redactPII` runs
  for all providers and the admin page states this. Per-provider retention/no-train terms are the
  operator's responsibility.
- Test-connection is an admin-only key-validation oracle; provider base URLs are not tenant-configurable
  (no SSRF surface). Rate-limiting it is deferred.

## Status of must-fixes

All twelve controls from the pre-implementation security review are implemented and covered by
`test/ai-config.test.ts` (crypto round-trip + cross-tenant + tamper; the app role cannot read the
ciphertext column; admin-only writes; one-active; resolve/decrypt; remove → off) and
`test/performance-ai-draft.test.ts` (draft-only, manager-gated, fail-closed, redaction, audit).
