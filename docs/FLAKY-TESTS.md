# Flaky and time-dependent test register

Owner decision: [ADR-0175](adr/0175-first-time-right-releases.md) decision 5, 4 November 2026.

## Rules

- A registered test **still runs in every gate and still fails the run**. It is never skipped, never made non-blocking, and never moved out of a release unit.
- Registration permits exactly one thing: once the reviewed single-shot recovery route exists (ADR-0175 Phase 1), it may be used once per candidate, and only when the test lies outside that candidate's impact set. Until then, the existing recovery routes and their limits apply unchanged.
- To add an entry:
  - give evidence of the same test passing and failing on the same source (run IDs);
  - name an owner;
  - set a due date.

  Diagnosis notes belong in the owner's branch or PR, not here.
- An entry that is past its due date blocks releases that change its area.
- Time-dependent tests (a date or weekday captured at module load, or a fixture that depends on the hour) are fixed by deriving dates through the repository's HR date owner and pinning the clock. They are listed here until that fix lands on main.
- Remove an entry only when the fix is on main **and** a later full gate ran the test green. Record that run ID in the commit that removes the entry.

## Entries

Statuses come from the [release log](reviews/release-speed-review-2026-11-04.md) as of 4 November 2026. Check the current source before relying on them.

| Test | Engine/unit | Failed (run, source) | Passed (run, source) | Kind | Status | Owner | Due |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `test/lifecycle-v9-html-gaps.browser.test.tsx`, "atelier light mobile", keyboard Enter accordion commit poll (line 46) | browser (firefox) | 41773236616, aa260e8d0 | 41769768119, 3ceeb26ef (all engines) | flaky timing | Being diagnosed by the AI v2 release session; history of earlier fixes (c5a7b4302) | AI v2 release coordinator, with the lifecycle owner | Before the next lifecycle release |
| `test/onehr-ui.dom.test.tsx`: unhandled `window is not defined` from `app/performance/onehr/draft-form.tsx:44` during teardown | no-DB unit | 41482125188, dfbcf85b1; earlier 40990989039 (autosave callback) | all 3,225 assertions in that unit passed in the same run | teardown race | Open; verify | Performance owner | 2026-11-11 (proposed) |
| `test/mobile-v2-leave*`: TODAY captured at module load | DB unit | 41475967412, dfbcf85b1 (started 23:58 KL) | 41482125188, dfbcf85b1 | time-dependent | Proposal sent to Codex on 2 November; verify | Mobile owner (Codex) | 2026-11-11 (proposed) |
| `test/ai-delivery-native-fixtures*`: `c.today` refuses after midnight | DB unit | 41475967412, dfbcf85b1 | 41482125188, dfbcf85b1 | time-dependent | Open; verify | AI delivery owner | 2026-11-11 (proposed) |
| Weekday-dependent leave fixture | DB unit | 41693210410, candidate 2cee0e8b5 | fixed in d895f80b9 | time-dependent | Fixed on the AI v2 branch; remove after a green full gate on main | AI v2 release coordinator | — |
| `ai-centre-evidence` script-font proofs | no-DB unit | twice during Phase 2 integration (3a5273a02) | once, unchanged | flaky rendering | Fixed at 07c395db3 (page hidden until fonts load); remove after a green full gate on main | AI v2 release coordinator | — |
| `test/rewards-cancel-custody*`: `5000` matched inside a random company ID | DB unit | 41459296654, 41ec7fd8c | passed on 6ea889365 | chance match | Fixed with a `\b5000\b` word boundary (2 November); remove after verifying on main | Rewards owner | — |
