# Canonical pure reminder preparation decisions

Status: source extraction checkpoint only. Parent is exact-audience d95a043fe.
No native reminder capability is enabled, no unsupported family is marked complete,
and no fallback, sweep, provider, schedule or deployment behavior changes.

The shared reminder resolver previously interleaved eligibility decisions with its
read/preparation writes. The new reminder-preparation module owns the same pure
initial/route/epoch decisions and exact skip/success values. The ordinary resolver
still reads actual rows, current projection and cooldown, performs both native
epoch reads and writes the same prepared fields under its existing transaction/RLS.
An initial automatic-disabled/no-work refusal still precedes cooldown; cooldown
still precedes consent; both precede the second epoch/deadline proof. Wording is
still read only for success, after capturing the same preparation timestamp. The
existing task graph, cache scope/keys, expiresAt computation, rules, consent,
20hour cooldown, Kuala Lumpur day/window gates and60second preparation cap stay
with their original owners. No financial or review-decision calculation changes.

The pure module has no database or application-pool import. It accepts explicit
facts and returns data; it grants no authority and cannot perform hidden writes.
Its future native adapter must obtain event-bound facts, recheck native epochs and
deadline and apply only the bounded preparation mutation in the actual projection
transaction. This extraction does not substitute a recipient list for those writes.

Authored tests assert refusal precedence, exact complete/reordered/changed epoch
sets, strict expiry equality, every skip-field clearing, existing rendered wording,
unchanged task/epoch inputs and exact lower expiry/60second/default epoch bounds.
Existing real service/reminder work/words/owner tests remain required to verify the
web adapter; no test execution is claimed. Root owns standard hosted focused
qualification and the complete compiler. No local app/DB/runtime/compiler/build
checks, public upload, numbered migration or live installation occurred.
