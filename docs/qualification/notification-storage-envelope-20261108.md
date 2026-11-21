# Preserve both reminder parser and storage contracts

Exact parentc0a32769f2de63323708d0b8aa94210fc4f5271c. Its pure canonical-parser
run42400440528 passed2 cases. Native run42400433581 passed40/41, including the
actual code-point/trim/date/decimal/current-epoch/receipt/cursor cases. The one
new escaped-text positive failed23514 at the existing recipient mail_words CHECK.
Retain those identities and original results; the failed workflow stays failed.

The earlier c0 qualification note derived a larger byte envelope from parser
shape alone. That missed the canonical storage contract in applied0540: tasks
are at most16 groups AND20,000 JSONB-text bytes; words are at most220,000 bytes.
A parser-valid payload does not override those independent storage safeguards.
No evidence here justifies changing or weakening them.

Restore prototype wire bounds20,000/220,000/260,000 bytes. Keep the actual Unicode
code-point fix, canonical logical limits, exact parser pins and all prior native
authority/identity/epoch/source/consent/outbox/cursor proofs. No applied SQL,
schema, grant, stored fact, calculation, timeout or global resource changes.

The full16-group positive now uses3 names of200 ASCII code points per group and
20k/30k ASCII words, all within native storage bounds. The separately passed
Unicode maximum remains unchanged. Escaped text instead proves explicit storage
domain refusal in two independent controls: task overflow with safe words, and
word overflow with safe tasks. Both must pass the actual parser; real server
JSONB byte measurements must exceed exactly the targeted limit, keep the sibling
within its bound and stay below260,000 total. The API must refuse22023 before a
storage23514, leaving every preparation/projection/receipt/cursor fact unchanged.
The earlier parser-valid66k fractional date also remains an operational refusal.

After independent review, rerun the affected sole native lifecycle file on its
normal isolated hosted profile. Retain c0's unchanged2 pure passes and172 earlier
canonical assertions. Any future producer/storage alignment needs an actual
canonical producer failure, every writer reviewed, bounded resources and guarded
appended migration/populated rehearsal. This wire fixture is not such evidence.
No worker installer, live/provider operation or staging/production authorization.
