# ADR-0030 — Append-only audit log vs PDPA (Layer 0: redact-to-reference)

Status: **Accepted.** (2026) Go-live gate **G3** (product plan v2). Closes security finding **S1**.

> **Layer 0 (redact-to-reference) ships in the gate slice** — it closes S1 with **no crypto**. Layer 1
> (per-subject crypto-shredding) and Layer 2 (per-tenant hash chain) are a follow-up hardening slice.
>
> **Implementation status (#159):** Layer 1 crypto-shred vault (`pii_key` + `lib/pii/vault.ts` +
> `core/pii-vault.ts`), the `erasePersonPii` retention-guarded service (`core/pdpa.ts`), and the Layer 2
> per-tenant hash chain (`domain_event.chain_seq/prev_hash/hash` + the migration-0074 trigger + GUC gate
> `AUDIT_HASH_CHAIN_ENABLED` + `core/audit-chain.ts` `verifyTenantChain`) are **shipped and tested**. Still
> pending: the **one-time owner-only historical-event redaction migration** (§3), which must also **backfill
> the hash chain over the post-redaction payloads** before the chain is complete on an existing tenant. The
> vault's master key is still the env-derived envelope — swap to KMS/HSM before sealing real payroll PII at
> volume. The plain SHA-256 chain is tamper-EVIDENT given a trusted head; anchor the head hash externally
> (or move to an HMAC keyed by a non-DB secret) for evidence against an attacker with DB write access.

---

## 1. Context

ADR-0006's `domain_event` log is **append-only** (`db/events.ts → appendEvent`; migration 0001 L166
`REVOKE UPDATE/DELETE/TRUNCATE` + INSERT-only RLS). A payload cannot be deleted, so sensitive PII written
into a payload is **undeletable** — finding **S1**.

**Live leaks (verified in code):** `comp.ts:53` (raw `basicSalary`); `pay-components.ts:194,239`
(`amount`, where BASIC = salary); `payroll.ts:299,435` (`overtime`, `bonus`, `tp1`, `zakat`, input
amounts); `claims.ts:262,300,614,724` (claim amounts). `core/profile.ts` was already fixed (task 105 —
stores field names + ids only). NRIC and bank are **not yet** in payloads (exports log counts) but are a
**latent** risk. `profile_change_request.proposed` (`schema.ts:685`) holds cleartext bank values but is a
**mutable** table — directly erasable. `lib/ai/crypto.ts` provides an AES-256-GCM envelope keyed by one
global passphrase (not per-subject).

**Statutory (official sources):** Malaysia's PDPA has **no GDPR-style erasure right.** The relevant duties
are the **Retention Principle** + **destroy-when-no-longer-required**, and **correction** (ss.34–37). The
**2024 Amendment** added breach notice to the Commissioner within **72 hours** and to affected subjects
within **7 days** on significant harm; penalties up to **RM250,000 and/or 2 years**. So the design goal is
**data minimisation + retention-honouring destruction + correction + breach blast-radius reduction** — not
"erasure."

---

## 2. Decision

### Layer 0 — redact-to-reference (this slice, no crypto)
Raw sensitive values **never enter payloads.** Replace them with the **changed field names** + a
non-reversible **reference to the versioned row** that already holds the value:
| Site | Drop | Keep |
|---|---|---|
| `comp.ts` `compensation.changed` | `basicSalary` | `employmentId`, `compensationId`, `effectiveFrom`, `fieldsChanged` |
| `pay-components.ts` | `amount` | `componentId`, `assignmentId`, `effectiveFrom` |
| `payroll.ts` input-set | `overtime`, `bonus`, `tp1`, `zakat` | `employmentId`, `payrollInputId`, `source` |
| `claims.ts` | `amount` | `claimId`, `claimTypeId`, `taxable` |
The figures remain on their own RLS-scoped rows (`compensation`, `payroll_input`, `claim`, the retained
`payslip`); the event proves **who changed what, when, on whose authority** via the reference id.

**CI guard:** a grep that **fails the build** if `bankName`, `bankAccountNo`, `icNumber`, `basicSalary`,
`netPay`, `grossPay`, `epfNumber`, `socsoNumber` or `taxNumber` appears as a payload key unless wrapped by
a `seal()` helper. Ban object-spreads into `appendEvent` payloads in review (the grep can't see them).

**Mutable side-table:** seal or retention-NULL `profile_change_request.proposed` after the request is
decided.

### Layer 1 — per-subject crypto-shredding (follow-up)
For fields that **must** stay inline (bank, NRIC), seal as AES-256-GCM ciphertext under a **per-subject
DEK** from a new mutable `pii_key(tenant_id, subject_employment_id, kid, wrapped_dek, created_at,
destroyed_at)` table; the DEK is wrapped by a **KMS/HSM master key** (an env passphrase is too weak for
payroll PII). "Destruction" = NULL `wrapped_dek` + set `destroyed_at` → instantly voids every sealed blob
for that subject across the append-only log, **without deleting any event row**.

### Layer 2 — per-tenant hash chain (follow-up)
Each event row's hash covers the **ciphertext digest**, so shredding a DEK provably does not break the
chain; an auditor verifies no row was inserted, removed or reordered even after a shred.

### `erasePersonPii` service (`core/pdpa.ts`, admin/DPO-gated)
`(subjectEmploymentId, scope, reason, requestRef)` → (1) resolve `pii_key` rows; (2) **retention guard**:
refuse fields under statutory hold (payroll/tax/EPF ≈ 7 years) and return a partial naming what was
withheld and why; (3) crypto-shred; (4) direct-NULL the mutable stores (`profile_change_request.proposed`,
caches); (5) **correction** (ss.34–37) reuses the same plumbing — a new effective-dated row + a
referencing `pii.corrected` event; (6) append `pii.erased`/`pii.corrected` with **no PII payload**;
(7) breach minimisation: a leaked dump holds no salary/NRIC/bank plaintext. **Fail-closed:** if the master
key is unavailable, sealing is refused at write time so cleartext is never silently stored.

---

## 3. Existing-event migration (historical cleartext)

Existing events already hold cleartext and the log is INSERT-only. **Do not loosen the app-role grant.**
Run a **one-time maintenance migration as the table owner** (not `ai_hr_app`, which keeps its REVOKE), in
one transaction, rewriting historical payloads in place to the redacted/sealed form; record it as an
`audit.payload-redacted` event. **ADR-0030 declares this a one-time owner-only logged exception, not a
precedent — runtime UPDATE/DELETE on the log stay forbidden.** Steps: (1) read-only inventory scan to
quantify the anchor tenant's blast radius; (2) per-row swap sensitive keys for the reference id where
derivable, else drop the key + add a `redacted` marker; (3) if Layer 2 is adopted, backfill the hash chain
over post-redaction payloads. Forward-only is **rejected** — the tenant's historical salary is already
undeletable cleartext, the exact conflict this gate closes.

---

## 4. Consequences / risks
- **Owner redaction migration mutates the immutable log** — fenced: app-role REVOKE kept, one numbered
  logged owner migration, runtime UPDATE/DELETE still forbidden.
- **Key custody** (Layer 1): a master-key leak or DEK-retaining backups can recover shredded data → KMS/HSM
  master key; backups expire within retention or propagate DEK destruction.
- **Pre-redaction history in WAL/replicas/logical backups** → rotate/expire or re-snapshot; record in the
  breach-risk register.
- **Over-claiming a PDPA erasure right is legally inaccurate** (Malaysia has none) → frame as
  Retention-Principle destruction + correction + breach minimisation.
- **Retention collision** — shredding tax/salary breaches ≈7-year LHDN/EPF retention → the retention guard
  refuses + logs; the ADR enumerates retention-locked fields.
- **Reference-not-value still leaks** if the referenced row is never erasable → keep referenced tables in
  the erasure/shred scope, or seal them.
- **Lint misses dynamically-assembled payloads/spreads** → ban spreads in review + dev-mode runtime scan.
- **ADR-0015 subject-scoping**: a Layer-0 reference id must not let a subject dereference a forbidden field
  → references point only to rows with their own RLS (compensation read is admin-or-self, migration 0060).

## 5. Sources
pdp.gov.my — PDPA (Amendment) Act 2024; Guidelines on Data Breach Notification; Commissioner Circular
1/2025 (DBN); DPO Appointment Guidelines; PDPA 2010 consolidated text (DataGuidance); DLA Piper MY data
protection; Tay & Partners "Data Breach — the first 72 hours".

## 6. UAT customer installation: audit policy at the database boundary

Migration 0528 applies the persisted tenant opt-in and ADR-0077 no-disarm-after-history rule in the
shared domain-event trigger. Raw authentication, private email and job connections bypass the
TypeScript tenant wrapper, so its session flag alone cannot protect those writes. The trigger uses
the existing per-tenant advisory lock before reading policy and history, preserves caller session
settings, and chains every new event once opted in or once chained history exists. Fresh customer
bootstrap explicitly enables the customer and reserved pre-authentication system tenant. Legacy
tenants with no opt-in, session fallback or chain retain the previous unchained behavior.

This adds policy enforcement to all insert paths, not historical redaction or backfill. The database
owner remains trusted and can alter functions or history; externally anchored evidence is still
required for tamper evidence against that owner. Raw app-role, restricted private-email-role, job,
pre-authentication and concurrent append regressions exercise the same database boundary.
