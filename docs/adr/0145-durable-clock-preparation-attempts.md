# Preserve a clock attempt before acquiring location

M01 requires evidence of an attempt even when a usable location, photo or server response never
arrives. Command-only persistence begins too late. Native preparation now commits an encrypted,
actor/employment/connection-scoped reference, action and phone-claimed start before acquiring GPS.
A restarted preparation reuses that reference and action; changing direction requires review and
server-ordered discard. Cancelling review retains the unsent attempt instead of silently erasing it.

Preparation is distinct from a transmittable clock command. Journal snapshot version 2 represents
this state; version 1 commands remain readable. Adoption atomically replaces the matching preparation
with the complete immutable command and evidence under the existing secure commit pointer. Its
format returns to version 1 when no preparation remains. An older binary refuses an outstanding
version 2 snapshot rather than treating it as empty. Storage pressure refuses the new save; unresolved
records are never evicted. A cancelled preparation keeps no plaintext photo reference.

An authenticated actor may report this minimal claim to a separate idempotent audit service. The
server stores its own receipt time alongside the explicitly unverified phone time, with no position,
photo, pay or free-text reason. The report cannot create, correct or approve attendance. Native
confirmation requires this attempt receipt before transmitting the clock command, so a definitive
clock refusal cannot erase the employee's only evidence. A lost attempt receipt retains the exact
command locally and sends no attendance; retry uses the same claim and command references. The
additional network exchange and server-first rollout are deliberate reliability trade-offs.

The alternative of reporting after a refused clock response loses proof when the app terminates
between response and reporting. Treating the phone time or an attempt receipt as accepted attendance
would bypass the server clock and adjudication rules. Neither is allowed. This is not offline punch
acceptance, platform attestation or proof of physical presence; M04/M05 and signed-device acceptance
remain separate requirements. The existing audit-retention owner governs reported events.
