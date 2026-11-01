# Harness ratchet (ADR-0170 §11.3 change 4)

Every guard block, failed holdout turn or incident becomes a permanent case in `cases.ts`, and
`ratchet.test.ts` runs every case through the product turn runner (`core/harness/runner.ts`) with a scripted
model (`scripted-model.ts`) and fictional tools (`fake-tools.ts`). No database, no provider.

Rules:

- **Append only.** Add a case to `APPENDED` in `cases.ts`; never edit, weaken or remove an existing case.
  Raise the source's floor in `RATCHET_FLOORS` in the same change. Floors never fall.
- **Fictional data only.** Write the turn with invented names, ids and figures, never a customer's words.
- **Assert harness invariants, not wording.** A case states what the gate decided, which calls must never
  reach an owner, what must stay fenced, which figures must never be sent, and whether the reply must be the
  spec fallback. Do not tune the gate, the instructions or the spec to make a case pass; fix the harness
  behaviour, and if that changes `HARNESS_SPEC`, raise its version.
- **Record the origin.** `origin` names the incident, run id or holdout id; `addedOn` is the date added.

Sources: `corpus_negative`, `conversation_holdout`, `adversarial_holdout` (seeded 1 November 2026),
`guard_block`, `holdout_failure`, `incident` (appended later).
