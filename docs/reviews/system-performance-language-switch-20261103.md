# Language switching: bounded preference update and actual-browser verification

## Observed mechanism and app repair

The human reports that changing the system language also takes a long time. This is
additional System Optimization scope, not a replacement for the security integration
and original500-user target.

Original app/i18n-actions.ts sets NEXT_LOCALE then calls revalidatePath('/', 'layout').
It also rewrites an already-selected explicit cookie. The shared switcher allows the
active language to submit and permits another submission while its action is pending.
The form intentionally stays mounted while hidden; keep that native submit behavior.

Installed Next16.4.1 cookies documentation states that a Server Action cookie mutation
can return updated UI/data in the same roundtrip; revalidatePath additionally refreshes
cached data. The relevant installed reference is
node_modules/next/dist/docs/01-app/03-api-reference/04-functions/cookies.md, section
Understanding Cookie Behavior in Server Functions. This supports removing broad data
invalidation, not a claim that every root/page database read disappears.

App source **329c870ace9a3636627255bdd304fbb7fded806b**:
- Writes a changed locale cookie with the existing path/Lax/year lifetime and invalid-input fallback.
- Returns without rewriting the same explicit preference.
- Leaves current UI refresh to the Server Action cookie response, without global revalidatePath.
- Keeps the form mounted; disables the selected language and duplicate submissions while pending.
- Shows a reduced-motion-aware pending icon and aria-busy state.

No session, role, scope, HR data, statutory country, provider contract or approved binding
changes. Both generated manifest checks retain exact prior b95f digests.

## Native action/DOM/compiler evidence

Original red **c4afdd04dcdaee9e01b7a93e4924dbc19c309266** /
[41502730627](https://github.com/StradaverseHub/ai-hr/actions/runs/41502730627):
1PASS/4FAIL exactly at broad invalidation, same-locale rewrite, active-choice submission
and pending duplicate controls. Artifact /private/tmp/aihr-language-red-c4af-attempt1.

Green329c /
[41504237801](https://github.com/StradaverseHub/ai-hr/actions/runs/41504237801)
passes19 checks across five affected files plus the fresh whole-repository compiler.
Coverage includes cookie behavior/fallback, real form submitter value, pending state,
mounted form, duplicate prevention, Home preferences and header contracts. Artifact
/private/tmp/aihr-language-green-329c-attempt1. This is component correctness and
compiler proof, not measured authenticated page speed or500-user acceptance.

## Separate real production-renderer diagnostic

An opt-in profile_language_switch lane inside the existing isolated selected-tests job
uses normal encrypted internal sessions, Chromium and a real production build.
It changes all six locales twice on Personnel and independently checks translated
server heading, html language, selected title, cookie, unchanged path and one action
per change. It records translation/font-ready elapsed time and compares p95 against
the original1s navigation goal. The current-language control must cause no redundant
submission. OS fallback fonts serve CJK/Thai/Tamil; source declares no language web-font
fetch in globals.css. No actual browser timing is qualified yet.

This is one active browser over the existing fictional500-account/2-tenant/10-company
fixture, reduced preflight history100kClaims/90kAttendance. It is explicitly NOT a
500-user run or million-record acceptance. One app worker, pool10, heap4GiB, standard
hosted runner, durable PostgreSQL profile2/JITon; no paid/larger runner or live target.
Original500 scripts/workloads/resources/targets/timeouts remain untouched.

Retained harness failures, not product speed measurements:
- c0fc3c830 /41504002691 refuses noncanonical application database before migrations/browser.
- Still-pending41504244376 had no jobs started and was cancelled to avoid the known same setup error.
- baseline1046eb8da /41505308490 and candidate394dc76f6 /41505307694 refuse the separately
  validated test database URL. No browser timing was produced. Both artifacts are retained.

The first repair addressed only the application URL; the second miss is acknowledged.
The final harness49ac1417e uses canonical development/test URLs, the strict direct
RUNNER_TEMP/aihr-focused evidence directory, the unchanged role owner and existing
migration engine. Only the fixture child points its test-owner connection at the
application's isolated development DB to seed real app data. The migration guard,
role graph, source/host checks and immutable SQL remain unchanged; native prerequisite
receipts are copied byte-for-byte into the diagnostic artifact.

Repaired baseline **86ded84e1fd7abb32ba65b7807464ff619d0ea4e** /
[41506755351](https://github.com/StradaverseHub/ai-hr/actions/runs/41506755351)
passes migrations, native prerequisite receipts, catalogs and the fictional fixture,
then FAILS during production-build TypeScript at the original6144-MiB build heap.
The bundler itself finishes; V8 runs out of heap during type analysis. Cleanup passes.
No browser starts; this is not a product latency measurement. Artifact:
/private/tmp/aihr-language-baseline-86de-attempt1.

Harness-only **48f90a1d08d32961b21d93078550324084bc102e** uses the existing
.github/ci/build-heap.mjs exact8192-MiB admission, actual standard-host memory check
and measured build RSS budget. It does not alter that guard or its ceiling, skip
TypeScript or change the runtime4-GiB heap, pool10 or PostgreSQL resource profile.
Baseline **502dba4448640152e5dfdf0171da3dbace98b885** /
[41509413854](https://github.com/StradaverseHub/ai-hr/actions/runs/41509413854)
is running first. Candidate harness48f90 has exactly329c application code. Run
candidate timing only after usable baseline preparation; retain each original
failure/source rather than relabel or blindly repeat the passing focused compiler.

No language-speed percentage, completed browser acceptance, deployment, staging slot,
approval binding refresh or production-equivalent infrastructure is claimed.
