# Assistant file import preparation

The Assistant accepts one PDF, Excel or CSV file, an explicit import target and a written request.
The user reviews the extracted source and consents to disclosure to the configured AI provider.
The Assistant prepares an editable draft. The user checks it against the source, then continues
to the existing import workbench for validation, effect review and a separate explicit confirmation.

Supported targets are Employee Master, leave history, leave brought-forward balances, payroll
history, recurring payroll transactions and individual payroll transactions. These targets retain
their own company selection, balance semantics, replacement decisions, permissions, audit history,
validation and commit services. No business records are written by preparation or by the handoff.
The recurring/individual workbenches may validate a received draft immediately; they still require
their existing Confirm control to write. Other workbenches receive text for explicit validation.

## Authority and model boundary

The server action gets a cookie-authenticated command session. Preparation requires a current AI
principal, the user's Assistant grant, an HR/super-admin role and the target module. These checks
run before provider resolution and again at metered admission. The operation uses hr_assistant:
the existing Assistant feature pause, user/group allowances, concurrency and provider controls apply.
It is an extension of the Assistant workload, with its additional caller registered in the gateway
inventory. There is no separate model transport, provider SDK, feature allowance or database table.

Source text is user-supplied data, never a grant, command or authority to access other records.
The model receives only the selected source text or numbered table rows, the user request and canonical field identifiers.
It cannot call tools, query records, choose an arbitrary destination or invoke an import writer.
Output is strict bounded JSON containing canonical field names and source cell/quote selectors.
For a spreadsheet, the server sends numbered rows and derives values from whole cells, preserving
CSV escaping and avoiding model character-count arithmetic. For PDF text or explicit literals in
the user request (such as a stated start date or pay code), it verifies exact quotes in that source.
The server rejects unknown fields, extra keys, nonexistent cells/quotes, invalid or empty spans,
repeated fields and repeated source records. It never accepts model-authored replacement values
or calculated amounts. Interpretation and completeness remain fallible, so the review explicitly
asks the person to compare identifiers, dates, amounts and record counts with the source.

Personal/payroll values in a selected file may be disclosed to the configured provider after the
separate explicit consent checkbox and Prepare click. This is broader than the Employee Master
workbench's existing headings-only assistant; that existing boundary is unchanged. No database
record or live employee catalogue is sent as preparation context. The gateway keeps its existing
usage/digest accounting. Preparation does not add prompt bodies, source text or drafts to chat
history, telemetry, URLs, localStorage or sessionStorage. Provider-side retention follows the
configured provider's terms; local discard cannot undo an already dispatched provider request.

## Local state and handoff

Binary decoding runs in the browser through the existing spreadsheet reader or PDF.js.
The original binary is not sent to the provider or retained as import evidence. The source text and
draft live in this tab's React state for ten minutes and are cleared by discard, expiry or reload.
Every nonempty Excel sheet is offered separately, with a visible notice that other sheets are not
included. A workbook is never silently reduced to the first sheet.

The prepared CSV passes through a one-use memory carrier under the authenticated app layout.
The provider is keyed by a server-generated tenant, principal, grants and selected-company-scope
fingerprint. Its ten-minute nonce is bound to one of six fixed destinations. The URL contains only
that nonce; the native importer takes the matching CSV once. Reload, missing carrier, expiry or
wrong destination cannot recover another draft. The canonical server services independently
recheck authority and records; this client carrier grants no permission.

The native import audit retains its existing source semantics. Payroll history receives a derived
assistant-prepared.csv; other flows receive prepared/pasted text. The original PDF/workbook is
not represented as the original file of that derived import. If durable original-document evidence
is required later, it needs a separately authorised retention and access policy.

## Bounds and failures

The intake allows a 5 MB file, 20 PDF pages, 48,000 source characters, 200 proposed records and
one explicit provider dispatch per click, with no automatic retries. Larger input is refused, not
truncated. The existing spreadsheet decoder adds its own decoded-size/range limits. Only PDFs
with extractable text on every page are accepted. Scanned, mixed scanned/text, encrypted and
unreadable documents must be converted to a readable text PDF or spreadsheet first. OCR is not
part of this change. PDF parsing has a 15-second cleanup deadline and extracts text without rendering
the document or running document scripts.

Changing the file, target, sheet or request invalidates the draft and disclosure consent. Discard
or expiry invalidates in-flight results. A failed provider or malformed output shows a generic
failure and offers no import confirmation. CSV edits update the review table and reset the user's
review acknowledgement. CSV serialization preserves signed amounts and zero-prefixed identifiers;
it is an import transport, not a downloadable spreadsheet export. Formula and Excel-error counts
are shown before provider disclosure. Extraction uses cached values and never recalculates formulas.

## Verification scope

Focused tests cover closed contracts, exact-source values, invalid/fabricated cells, quotes or spans, duplicate
records, consent, separate review, selected-sheet disclosure, discarded responses, one-use/expired
handoffs, access refusal and admission-time revocation. Browser tests exercise actual PDF.js and
the existing Excel decoder, plus real styled desktop/phone draft views. These checks use synthetic
documents and stub the paid provider; they do not establish live-model extraction quality or a
staging installation. Release still requires the repository gate, rendered authenticated native
import journeys, migration-prefix verification for the release as a whole, and a staging provider
fixture with an explicitly authorised small request.

## Provider setup and restricted database owners

OpenRouter Save stores an inactive candidate. The existing provider page then requires account
policy review, explicit consent to synthetic protocol calls and activation of the unchanged
candidate. A successful candidate save is separate from a working hosted route or accepted file
preparation. Failed key saves require the user to enter the key directly again after repair.

Migration 0686 gives the existing candidate and protocol-evaluation owner functions tenant-bound
custody policies. Both tables retain FORCE RLS and their app-role table revocations. A policy
requires the actual table owner and the existing fresh group-administrator predicate; it does not
grant ordinary app queries access to ciphertext or evaluation rows. The regression exercises the
pre-fix 42501 failure, the exact upgrade SQL, native storage/promotion and direct-access, foreign
tenant, missing-principal, stale-grant and consumed-evaluation refusals with a non-bypass owner.
Synthetic database fixtures do not establish hosted-provider readiness or permission to save HR
records. Staging file verification must stop before every native import confirmation.
