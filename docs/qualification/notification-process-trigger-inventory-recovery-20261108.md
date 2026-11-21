# Seal the complete native process trigger inventory

Fixture-only recovery from frozen `a5b2d0454fe7185084b553c1eb9c351143293177`.
Both planned chunks finished: native run `42405285922` failed with41 existing
cases passed and10 process cases failed; pure run `42405291849` succeeded.
The original51-case failure is retained, never relabelled onto this source.

The native failure is `55000 Exact native process profile unavailable`, reached
from `process_start_guard` before `open_run` can admit a run. The original guard
counted **every** trigger on private-schema relations but captured only the three
named custom triggers. Real foreign keys install additional internal RI triggers.
The retained artifact contains no catalogue dump, so an actual trigger count is
not observed yet. This correction does not invent one or change a threshold to a
guessed count.

The process contract now captures full `to_jsonb(pg_trigger)` metadata for every
private-relation trigger **and** both sides of FK constraints whose source relation
belongs to the private schema. This includes the referenced-side native triggers
on public relations without claiming unrelated public triggers as owned. Native
admission compares exact membership in both directions and every captured field.
Added, missing, disabled, retargeted or otherwise changed triggers refuse.

The three custom triggers remain a separate fixed obligation: exact relation and
function binding, row/event flags, enabled state, no arguments/WHEN predicate, and
the original deferred settlement trigger remains DEFERRABLE INITIALLY DEFERRED.
The complete inventory must contain actual internal FK triggers; they are not
filtered out of security inspection. All original29 predecessor body/metadata
guards,33 process functions, relation constraints/columns, authority, grants and
data/commit/abandonment checks remain intact.

The owner fixture writes a bounded catalogue artifact before profile assertions:
`notification-process-trigger-catalogue.json`. It records source/run/attempt and
owned database identity, actual/sealed/custom/mismatch counts and at most512 full
trigger metadata rows/definitions. A513th row marks truncation and fails; a2MiB byte cap retains only counts on overflow and fails. Output
is restricted to the real focused/full-CI evidence directory; no credential, HR
content or caller-supplied acceptance field is included. Counts are reported as
measured only after the hosted artifact exists.

The existing final process case adds actual hostile catalogue controls without
removing any of the51 declared cases. The fictional owner briefly disables one
private-side FK trigger, one referenced-side private-owned FK trigger and the
original deferred custom trigger. It executes only the profile refusal while the
guard is disabled, restores exact native metadata in `finally`, and rechecks the
complete profile. No business write or admission runs during that hostile window.
An added unexpected trigger also refuses and is removed only after exact identity
verification. A real23503 invalid ledger reference then proves native FK enforcement
is still active, instead of relying on an enabled catalogue flag alone.

The selector remains `notification-worker-process-focused-tests.json`: the same
51-case native owner file plus unchanged pure task-shape fixture. Current source
is unrun and needs root plus independent review before standard hosted recovery.
The process itself, entrypoint, limits, LOGIN privileges, projection/reminder
semantics, original stage fixtures and page catch-up are unchanged. No local
application/runtime/compiler/DB checks, provider call, upload, numbered SQL,
installation or production operation occurred. The prototype stays uninstalled;
all original process functional claims remain unqualified until actually exercised.
