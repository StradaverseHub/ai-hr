# ADR-0130 — Movement workbook admission and employment test classification

> Decision record at its recorded date; implementation/status observations are historical. Verify current source and later amendments. [Branch/release policy](../REPOSITORY-AND-ENVIRONMENTS.md) governs operations.

Date: 2026-10-19. Direction accepted in Movement Import revision 2 (f17cf3c4).
**Partly superseded by [ADR-0153](0153-single-sheet-movement-import.md):** the per-type sheets and the company
binding of the workbook envelope. The key custody, rehearsal and Test record decisions below stand.
Implementation and runtime verification are pending; this decision is not a release receipt.

Movement spreadsheets remain an input adapter to the existing Movement owner and its private
sequence rehearsal/replay. A workbook cannot authorize a person, change a company, decide a salary,
or classify an employment. This keeps preview, future intents, payroll guards, entitlement changes,
and append-only history under their existing owners.

Personnel owns one explicit employment-level Test record marker. Its only business decision consumer
in this scope is choosing a new Direct Superior in Movement imports, including an Entity Transfer.
A marked employment remains eligible as the subject of an exercise; a carried, unchanged marked
superior is not a new selection. False means unmarked, never certified real. There is no heuristic
backfill or effect on lifecycle, payroll, access, leave, or notifications. A dedicated HR command
checks current company administration and writes only the marker plus its actor/before/after audit
in one transaction. Generic Personnel imports, ordinary tab saves, reports, and ESS cannot write it.

Import employee transactions and the dedicated classification command acquire the same tenant
transaction advisory admission lock before their existing type/statutory/employment locks. This
serializes the new reference-classification decision without adding late manager row locks or
changing the generic reporting-line owner. It does not assert global reporting-graph serializability.
Preview fingerprints retain prior employment, catalogue, history, and event evidence, excluding only
the new marker and its exact dedicated metadata event. A genuinely new superior additionally binds
its flag and latest classification event under the always-present domain-event sequence, including
false-to-true-to-false changes. Subject, unchanged-superior, and unrelated flags do not stale a preview.

The workbook carries a purpose-separated company HMAC and an authenticated format/type/sheet/layout/
identity envelope instead of raw or reversible UUIDs. Its dedicated server-only
MOVEMENT_IMPORT_WORKBOOK_KEY is exactly 32 random bytes encoded as base64url; the public
MOVEMENT_IMPORT_WORKBOOK_KEY_ID identifies the one current key. Neither identity nor PII-vault keys
are reused. Configuration is read on demand: absence or malformed values refuse affected workbook
endpoints without preventing an unrelated application build or legacy CSV import. Changing the key
or ID rejects older workbooks and requires a fresh download; no implicit fallback or grace key exists.
Provisioning keeps the key out of source, client bundles, workbooks, SQL, and diagnostic output.

This trades invalidation of old workbook files on rotation for a small, explicit custody contract.
The rejected alternatives were a reversible company ID, reusing an authentication secret, and treating
sheet protection, grey cells, cached green formulas, or a signed envelope as authorization. Passwordless
protection only prevents accidental editing. Server parsing, current scope, catalogue validation,
exact-money adaptation, ordered rehearsal, and confirm-time stale checks remain authoritative.
