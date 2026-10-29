# ADR-0158 — Durable Bank & Statutory imports

Date: 29 October 2026. Status: implementation candidate, awaiting release verification and staging acceptance.

Production read-only evidence showed Personnel validation and Bank & Statutory confirmation connections
closing at approximately 125 seconds while confirmed changes continued saving. The installed source
revalidates the entire input for each saved row and uses the ordinary import reader's 900 KB text ceiling.
A browser timeout therefore reports an unknown outcome, and a new operation key admits another concurrent
submission of the same file. This is unsuitable for 100,000-row files.

Use durable, creator-scoped jobs for this import. Admission reserves the original file's SHA256 under a
partial unique index on tenant and hash. Uploads use idempotent 1 MiB parts. A separate supervised worker
checks the checksum, decodes the source and validates bounded batches. No HTTP request waits for validation
or saving. A ready preview requires explicit confirmation. Progress and preview pages contain at most
100 rows. The supported input budget is 250,000 data rows and 128 MiB original/decoded text, with additional
worksheet/cell bounds. Other importers retain their existing limits.

The queue context is captured by a database trigger from the authenticated principal, never from posted
JSON. Only its creator with a current principal can read the job and its preview. Tenant-wide active-source
uniqueness also prevents a second administrator's same-file submission without disclosing that job's data.
A physical-owner connection discovers jobs and holds a PostgreSQL session advisory lock. It never enters
an HR writer. App-role transactions use the captured actor and re-resolve current entitlements; existing
principal, employment, person, company, country-pack and canonical statutory writer checks remain binding.
Removed access stops future work without rolling back earlier authorized rows.

Each saved HR row, immutable before/after item and durable row checkpoint commit together. Restart skips
completed rows. Completion records one shared confirmed event; the original source and successful changes
remain in the existing Import History. Validation checks whole-file employee/Card ID collisions before
chunking, preserving cross-batch refusals. Commit revalidation addresses only the one employee being saved
and compares its preview binding under the existing writer locks. A bounded Bank-specific read projection
uses the current-principal proof, the existing company HR floor and live Workforce employment/person
predicates; it avoids repeatedly materializing the legacy tenant-wide visibility set. Existing global
row policies are unchanged. Queue child-row policies use the authorized job set once per statement.

Do not use a web process promise, `after()`, an elapsed lease that can expire during a slow write, or a larger
HTTP timeout as the queue. Process death releases the session lock while database checkpoints survive.
An unfinished upload or ready preview remains reserved until its creator resumes or cancels it. A completed
file may be deliberately reimported; unchanged rows are skipped. SHA256 identifies original bytes, not the
semantic equivalence of separately re-saved Excel archives.

Worker installation and recovery requirements are in [the operator guide](../../deploy/systemd/BANK-IMPORT.md).
Migration 0678 and its appended journal entry are an owned source allocation based on the freshly fetched
main/alpha journal; final integration must reconcile any later allocation and the target's actual watermark.
No production schema, worker or application change is authorized merely by adding these files.
