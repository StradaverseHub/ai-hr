# ADR-0020 — Vendor statutory data-pack distribution (hardened)

Status: **Accepted** · Date: 2026-06-15 · Builds on [ADR-0019](0019-editable-statutory-config.md)
· Revised after a 5-lens adversarial design review (security / correctness / RLS / operability / payroll).

## Context

ADR-0019 made the MY statutory figures injectable and per-tenant DB-overridable, with
`DEFAULT_MY_STATUTORY` (verified code constants) as the national baseline. The remaining gap: a national
correction propagates only at the speed of an **app code release**.

Owner decision (2026-06-15): (1) statutory data is a **vendor-owned national asset** (the vendor verifies
against the gazette and ships to every tenant; per-tenant override stays break-glass), and (2) updates must
propagate **without a code redeploy**, **fully hardened**. Cadence research
(`docs/research/2026-06-statutory-change-cadence.md`): an annual Budget pulse (~Oct), effective 1 Jan / 1 Oct,
1–12 month lead; changes are often **bulk whole-table replacements**; the **employer carries the statutory
liability** for under-deduction. A signed-but-wrong national figure therefore has fleet-wide, employer-borne
legal blast radius — which sets the security bar.

The design review found, and this revision fixes: a proven RLS default-privilege write leak; a precedence
rule that silently shadows vendor corrections; "canonical JSON" signature malleability; no key *revocation*;
roll-back / freeze / SSRF on the remote pull; signed-but-unvalidated pack content; and a latent ADR-0019
bug where reports/CP39 stamp the code-constant version instead of the payslip's actual version.

## Decision

### 1. Two-tier signing — offline root key certifies revocable operational keys

- An **offline ROOT key** (ed25519). Its **public half is the only key hardcoded in the build**
  (`localization/statutory-pack/trust.ts`, CODEOWNERS-gated). The private root key is air-gapped and only
  ever **certifies operational keys** and **signs the trust bundle** — never packs.
- **Operational signing keys** (ed25519) sign packs. Each is introduced by a **key certificate**
  `{ keyId, publicKey, certifiedAt, expiresAt }` signed by the root key.
- A **trust bundle** (signed by the root key) lists active key certs **and revoked keyIds with `revokedAt`**.
  It is ingested like a pack. **Revocation propagates at data speed**, not build speed: a leaked operational
  key is revoked by the root by shipping a new trust bundle.
- Verification is **retroactive**: ingest rejects a pack signed by an unknown/revoked/expired keyId, **and**
  the loader (§6) excludes already-ingested pack rows whose `signed_key_id` is later revoked. Break-glass:
  setting `STATUTORY_PACK_DISABLE=1` pins the engine to the code default + tenant overrides only.

### 2. Artifacts — raw-byte–signed envelopes, freshness, monotonic versioning

To eliminate JSON-canonicalization malleability, **the signature is over the exact UTF-8 bytes of a string
payload, which is verified and *then* parsed** — never re-serialized. Every artifact is an envelope:

```jsonc
{ "schemaVersion": 1, "keyId": "my-op-2026a", "sig": "<base64 ed25519 over utf8(payload)>",
  "payload": "<the JSON string that is hashed, verified, and only then JSON.parse'd>" }
```

- **Pack** payload: `{ country, packVersion, issuedAt, validUntil, notes, rulesets: [{ version,
  effectiveFrom, data: StatutoryRuleset }] }`. `packVersion` is **monotonic** per country; `validUntil`
  bounds freshness; `effectiveFrom` **must be the first day of a month** (the kernel resolves one ruleset
  per monthly period and cannot split a period). Duplicate JSON keys are **rejected** on parse.
- **Index** (remote pull only) payload: `{ country, sequence, issuedAt, validUntil, packs: [{ packVersion,
  location, checksum }] }` — `sequence` strictly increasing (anti-rollback / anti-freeze).
- **Trust bundle** payload: `{ sequence, issuedAt, keys: [keyCert...], revoked: [{ keyId, revokedAt }] }`.
- A **SHA-256 checksum** over the **identical** payload bytes is a transport redundancy check only —
  verification **always requires a valid signature**; checksum-only is never accepted.
- A **committed cross-language test vector** (`localization/statutory-pack/testdata/`: a fixed envelope + its
  expected signature + the test public key) guards any future signer/verifier reimplementation.

### 3. Storage — national, owner-write-only, provenance on-row

- `statutory_pack` `(id, country, schema_version, pack_version, ruleset_version, effective_from date,
  data jsonb, checksum, signed_key_id, issued_at, valid_until, ingested_at, ingested_source)` — **no
  `tenant_id`** (national). `UNIQUE (country, pack_version, ruleset_version, effective_from)`.
- `statutory_signing_key` `(key_id, public_key, status active|revoked, certified_at, expires_at,
  revoked_at, trust_sequence)` — the materialized trust bundle.
- `statutory_pack_sync_log` `(id, ran_at, source, sequence_seen, ingested, failed, error)` — observability +
  partial-failure audit.
- **RLS (the trust boundary, enforced — not assumed):** for each table
  `ENABLE` + `FORCE ROW LEVEL SECURITY`; `GRANT SELECT TO ai_hr_app`; **`REVOKE INSERT, UPDATE, DELETE,
  TRUNCATE … FROM ai_hr_app`** (the live cluster's default privileges auto-grant `arwd`, so SELECT-only by
  omission does **not** work — proven in review); `CREATE POLICY … FOR SELECT USING (true)` (national data →
  **`USING(true)`, never a `tenant_id` predicate**, which would return zero rows and silently kill
  propagation). No write policy. A regression test asserts `has_table_privilege('ai_hr_app', …, 'INSERT')`
  is false and that a tenant session can `SELECT` a seeded row.
- Ingest provenance lives **on these rows** (and `statutory_pack_sync_log`), **not** in the tenant-scoped
  `domain_event` log (a tenant-less insert would fail its RLS `WITH CHECK`).

### 4. Ingest — owner-only CLI, atomic-per-pack, content-validated

- The **only writer** is `pnpm statutory:sync`, run **out-of-band as the owner role**
  (`MIGRATION_DATABASE_URL`, like `db:migrate`). **No HTTP route may trigger ingest.** Pack sources come from
  server config, never request input. Sources: the bundled bootstrap dir + an out-of-build `STATUTORY_PACK_DIR`
  + the optional remote pull (§5). Bundled packs are verified through the **same no-bypass** pipeline.
- **Per-pack atomic** (all its rulesets or none), **cross-pack best-effort**, **never a silent skip**: every
  failure is written to `statutory_pack_sync_log` and the command exits non-zero / alarms.
- **Verify pipeline per pack:** known `schemaVersion` → `keyId` resolves to an **active, unexpired,
  non-revoked** key → **ed25519 signature** over `utf8(payload)` → SHA-256 checksum → strict JSON parse
  (reject duplicate keys) → **`issuedAt` ≤ now+skew**, `validUntil` ≥ now, `effectiveFrom` first-of-month and
  within an 18-month horizon of `issuedAt` → **`validateStatutoryRuleset` (ADR-0019) on every ruleset** plus
  **sanity/delta bounds** (rates within a plausible envelope; a headline figure moving > X% requires an
  acknowledged "large-delta" flag) and the jsonb round-trip → **monotonic `packVersion`** (reject ≤ max
  ingested for the country) → `INSERT … ON CONFLICT (country, pack_version, ruleset_version, effective_from)`:
  identical checksum ⇒ idempotent skip; **different checksum ⇒ hard error** (identity reused with different
  content). A signed-but-malformed or absurd pack is **rejected**, never written.
- **Bootstrap:** the deploy runbook is `db:migrate` → `statutory:sync` (bundled), so a fresh deployment is on
  a vendor pack, not silently on the code-default floor. `statutory:sync` is added to `package.json`.

### 5. Remote pull — hardened, optional, signature-necessary-but-not-sufficient

If `STATUTORY_PACK_URL` is set (owner/deploy config only, never tenant/admin-mutable), sync also pulls. The
signature protects *content*; the *transport* is hardened independently: **https-only**, **host allowlist**,
**reject private/link-local/loopback IPs after DNS resolution and re-resolve on every connect**
(anti–DNS-rebind), **no redirect following**, **hard max payload size + max JSON depth enforced before
verification**, fetch **timeout + backoff + circuit breaker**. The **index is signed and its `sequence`
strictly increasing** — sync rejects an index whose sequence is below the last seen (anti-rollback) and
**alarms** when the newest trusted index is stale (freeze/withhold detection). An operator can **pin/rollback**
to a known-good `packVersion`.

### 6. Precedence — one deterministic merged resolver, total order, fail-safe

`getActiveStatutoryMY` is **rewritten** (it is what `loadRuleset` binds to) into a single merged resolver
over **three** sources in **one tx snapshot**:

Candidates = tenant overrides (`statutory_ruleset`, `effective_from ≤ asOf`, `archived_at IS NULL`) ∪ pack
rulesets (`statutory_pack`, `effective_from ≤ asOf`, `signed_key_id` **not revoked**). **Total order**, head wins, else `DEFAULT_MY_STATUTORY`:

1. `effective_from` DESC
2. **`issuanceTs` DESC** — `pack.issued_at` for packs, `override.created_at` for overrides
3. source rank: an override outranks a pack **only at equal `issuanceTs`** (a tenant must *re-issue* an
   override after a pack to keep winning — closes the same-effective-date silent-shadow hole)
4. `pack_version` DESC, then `id` — final deterministic fallback

Consequences: a **newer-issued vendor correction supersedes an older tenant override at the same effective
date**; two packs correcting the same date resolve to the newer `issued_at`/`packVersion`; ties are
**deterministic** (the ADR-0019 single-table loader's missing secondary sort is fixed in passing). The query
**fails safe to the code default** on any pack-query error. **Empty pack + empty override ⇒ byte-identical to
today** (regression-guarded). `readActiveStatutoryMY` (the UI resolver) **delegates to the same merge** and
returns `{ ruleset, source: 'default'|'pack'|'override', packVersion?, issuedAt?, overrideShadowedByNewerPack? }`
so the screen always reflects what generation will actually apply.

### 7. Payroll integration — provenance, the version-stamp fix

- **Open-draft pin — found UNNECESSARY (review premise corrected):** the design review worried that
  re-generating a draft after a pack lands would silently adopt the newer pack. Verified against the code:
  `generatePayslips` requires `status = 'draft'` and transitions the batch to `processed` at the end; there
  is **no re-open-to-draft path**, and `payslip` is unique per `(batch, employment)`. So a batch is generated
  **exactly once** — a second call hits `BatchNotDraftError` (and the unique index blocks a double-insert).
  The resolved ruleset is therefore effectively pinned at that single generation, and a later pack cannot
  alter it. No pin column or re-gen opt-in is needed; the lifecycle already guarantees it.
- **Payslip provenance:** snapshot `pack_version` + `signed_key_id` alongside the existing `statutory.version`
  so a forged/wrong-pack incident is traceable to which key + packVersion produced which payslip.
- **Version-stamp fix (latent ADR-0019 bug):** `reports.ts` and `cp39-file.ts` must derive `statutoryVersion`
  from the **payslip snapshot** (`statutory.version`), not the imported `MY_STATUTORY_VERSION` constant; the
  import is deleted so the wrong source is structurally unavailable. (Without this, a CP39 filed to LHDN after
  any override/pack lands misreports which figures were used.)
- **Runtime guard:** `bandFor`/`annualTaxFor` throw a named, batch-aborting error on an empty band array so a
  malformed (but somehow-ingested) ruleset can never emit `NaN`/wrong-band deductions.
- **Equivalence tests extended:** empty-pack == today; a pack whose `data` equals `DEFAULT` (stored through
  **real Postgres jsonb**) yields **byte-identical** payroll across the existing sweep; explicit
  equal-effective-date override-vs-pack tie permutations.

### 8. UI — truthful source, freshness, reviewed handoff

`/payroll/configuration`: a **three-way active-source indicator** (built-in default / vendor pack +
packVersion + issuedAt / tenant override); a read-only **pack panel** with each pack's verification status
and `validUntil`; a **staleness signal** (latest *ingested* vs latest *available* packVersion + last
successful sync time, with a stale-pack alarm — the silent-stale failure is otherwise invisible); and an
**"accept vendor pack"** action that archives a now-superseded override (with a diff + acknowledgement) rather
than leaving a stale shadow.

## Consequences

- A national gazette change ships as a **signed pack**; deployments ingest via the owner-run `sync` (file-drop
  or hardened pull) **without a code redeploy**; key compromise is contained by **root-certified, revocable**
  operational keys propagated the same way.
- The DB **trust boundary is enforced** (explicit REVOKE + FORCE RLS + `USING(true)`), proven by tests — a
  tenant cannot forge or read-around a national pack, and the app role cannot write one.
- **Provenance is end-to-end:** signed bytes → validated content → on-row provenance → batch pin → payslip
  snapshot → reports/CP39 stamp the *actual* version filed to the regulator.
- **Out of scope (flagged):** retroactive recompute of already-*closed* batches for a late-landing fix;
  intra-period (mid-month) effective dates; multi-country packs (the format is country-keyed and ready).
- The verified **code default remains the floor and offline fallback** — with no packs, no trust bundle, and
  no network, the system is exactly today's.

## Implementation slices

1. **Crypto core + artifact format + test vector** (pure, no DB): envelope types, ed25519 verify (Node
   `crypto`), root→operational trust chain, raw-byte verify-then-parse, content validation + sanity bounds,
   committed test vector, unit tests.
2. **Schema + RLS migrations:** `statutory_pack` / `statutory_signing_key` / `statutory_pack_sync_log` +
   REVOKE/FORCE/`USING(true)` + UNIQUE; privilege + tenant-read tests.
3. **Ingest service + `statutory:sync` CLI** (file-drop sources): atomic-per-pack, monotonic, idempotent /
   checksum-conflict, sync log, bootstrap; bundled MY pack(s) signed with the committed test key for dev.
4. **Hardened remote pull:** SSRF guards, signed monotonic index, size/depth/timeout, pin/rollback.
5. **3-tier merged loader + payroll integration:** rewrite resolver, batch pin, payslip provenance,
   version-stamp fix, band guard, extended equivalence tests.
6. **UI:** three-way indicator, pack panel, staleness alarm, accept-pack/supersession diff.
7. **Adversarial test pass + verify + merge.**

## Alternatives considered

- **Per-tenant re-keying of national data** — rejected (ADR-0019): N copies, N divergent errors.
- **Tenant-override-always-wins / effective_from-only precedence** — rejected: silently shadows vendor
  corrections at equal effective dates and is nondeterministic between two same-date packs.
- **"Canonical sorted-key JSON" signing** — rejected: malleable and non-interoperable; raw-byte
  verify-then-parse sidesteps it entirely.
- **Rotation without revocation** — rejected: a leaked key stays trusted until every deployment redeploys —
  the exact slow path this ADR exists to escape. Root-certified revocable operational keys fix it.
- **SELECT-only-by-omission RLS** — rejected: proven false against the live cluster's default privileges;
  explicit REVOKE is mandatory.
- **In-repo packs as the redeploy-free channel** — rejected as the *primary* claim: bundled packs are the
  build-time bootstrap; genuinely redeploy-free propagation is `STATUTORY_PACK_DIR` drop-in, admin-staged
  upload, or the hardened pull.
