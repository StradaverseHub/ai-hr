# Preserve exact message owners at the compiler boundary

Source-only child of `05bde1cbb023f8d523a18774e92efe9fc2e295bc`. No compiler
acceptance or deployment claim; production remains held.

Both hosted traces cover the same11268 files with inventory SHA256
`64150993b2990e6b4b405a1211037cca665887fb5068f97bebfb3e1e54a5dbbd`.
Their tsconfig, lockfile, actual compiler bytes, Node22.23.3/TypeScript5.9.3,
12GiB heap and standard4CPU/~16GiB runner match. Both restore source/controller
cleanly, then report real V8 heap failure/SIGABRT without a diagnostic timeout or
monitor stop. Original fe26 run42392198414 fails after634.501s at sampled peak
12,860,052KiB;05 run42396515501 fails after548.200s at12,834,148KiB. Keep both
failures and ordinary05 OOM run42394530825 visible.

The earlier scoped translation repair reduces completed agent-principal checking
79.127→0.195s and r422-profile-dates26.109→2.371s. The05 trace completes6889 files
against6614 before, progressing275 files farther. These instrumented timings prove
less work at those boundaries; they do not prove a successful whole compiler.

The next completed constructor hotspot is
`test/rewards-approvals-board.test.ts:383`: its real createTranslator expression
spends34.303511s with all34,669 catalogue paths as its generic input. Its only
namespace is `rewards.board`. `packs/rewards/calendar.ts:rewardDueWording` owns the
closed overdue/dueToday/dueTomorrow/dueIn keys. The candidate passes the original
`en.rewards.board` object at its original nested path, preserving87 paths and every
value/reference within that namespace. No key, locale, ICU input, date helper,
permission, fixture, assertion or timeout changes. The existing real database
calendar test still checks today, yesterday, three days overdue, tomorrow and four
days ahead. Full providers and all six locale catalogues remain unchanged.

No generic erasure, assertion, shared unbounded namespace union or new translation
implementation is added. This one measured owner uses a literal typed projection.
The larger UI file durations are not evidence for the same cause: installed locked
use-intl4.13.0 has no repository AppConfig.Messages augmentation, and those hooks
have no full-en generic input. Their dynamic registry keys remain untouched.

The companion evidence JSON pins actual trace/report/sample bytes. No types.json
or successful final extendedDiagnostics exists after abort, so exact aggregate
instantiation totals and per-type retained memory remain unknown. RSS rises across
the graph, and all2143 recursive structural depth events remain unchanged. Nested
trace durations overlap and include GC; neither the last source file nor this
constructor is declared the sole OOM cause. Drizzle relations and graph retention
remain unresolved costs.

Qualification requires independent source review, the three existing selectors in
the companion focused manifest, and the normal complete strict12GiB hosted
compiler. All existing roots/options/dependencies remain unchanged. No local
application/compiler/build/runtime checks, upload or installation ran.
