-- 0376 — THE EARNING-METHOD CLEAR-OUT (bc36c768). A ONE-OFF RESET, at BOTH levels.
--
-- WHAT THE REPORTER ASKED FOR, in their words: clear every earning setting that exists today and mark
-- each leave type NOT CONFIGURED until they set it themselves. This is that, and it is deliberately not
-- routed through the ordinary writers.
--
-- ADR/PLAN: .plans/bc36c768.txt
--
-- ── WHY BOTH LEVELS, which is the whole reason this file is longer than a one-line UPDATE ─────────────
--
-- The Earning Method screen edits `leave_type.accrual_method`. The setting the CALCULATION obeys, for
-- most leave types, is one level down in `leave_policy.accrual->>'method'`, because `applyLeaveTypeRules`
-- only engages once a type carries at least one rule column (`hasAnyLeaveTypeRule`) and falls through to
-- the policy's own JSONB otherwise. Production counts taken 2026-08-04 make the gap concrete:
--
--     leave_type.accrual_method       15 NULL, 9 grant_on_hire_prorated, 1 earned_monthly
--     leave_policy accrual->>method   57 earned_monthly, 10 grant_on_hire_prorated
--
-- So a leave type can read "None" on the screen while 57 policy rows underneath it still earn monthly.
-- Clearing only the type-level column would LOOK like a reset and would not be one.
--
-- ── WHY NOT THROUGH updateLeavePolicy ────────────────────────────────────────────────────────────────
--
-- `reprojectEntitlementForPolicy` includes `method` in its `norm()` entitlement-changed test, so the
-- ordinary writer would treat this clear as an entitlement CHANGE and post compensating adjustment rows
-- against every affected employee. The reporter was promised that no balance moves on reset day. It is
-- the NOT-CONFIGURED marker below — not the choice of writer — that actually makes that true, and the
-- tests pin it at all five entry points (hire grant, accrual run, policy recalc, profile recalc, a2c).
--
-- ── SCOPE ────────────────────────────────────────────────────────────────────────────────────────────
--
-- ACCRUAL METHOD AND ACCRUAL DAY ONLY. Rounding, carry forward, maximum balance and the service-band
-- tables are untouched at BOTH levels. Rounding's own reset belongs to 8fec719e (migration 0358), which
-- has already run; doing it twice would be a second unexplained balance movement.
--
-- Every statement below runs in ONE transaction (drizzle's migrator wraps a migration file), so either
-- the whole reset lands with its audit trail or none of it does.

-- ── 1. THE AUDIT TRAIL, WRITTEN FIRST — this is the only rollback that will exist ─────────────────────
--
-- One `leave-type.rules.updated` event per non-archived type, carrying the full before/after. It is
-- written BEFORE the UPDATEs because `before` has to be read from rows that still hold the old values.
--
-- `before` records BOTH surfaces, not just the column this screen showed. The per-policy method map is
-- the larger half of the configuration being erased (57 rows against 1), so an event that recorded only
-- `accrualMethod` would document the reset without making it recoverable — which is the one thing the
-- reporter was told this event is for. Policy IDs, methods and scope only: no PII (the payload guard in
-- test/event-payload-pii-guard.test.ts is the standing rule here).
--
-- actor_type 'system': no human performed this, and attributing it to whoever happened to run the deploy
-- would be a lie in the audit log.
INSERT INTO "domain_event" (
	"tenant_id", "aggregate_type", "aggregate_id", "event_type", "actor_type", "actor_id",
	"subject_employment_id", "payload"
)
SELECT
	lt."tenant_id",
	'leave-type',
	lt."id",
	'leave-type.rules.updated',
	'system',
	NULL,
	NULL,
	jsonb_build_object(
		'reason', 'bc36c768 earning-method clear-out (migration 0376)',
		'before', jsonb_build_object(
			'accrualMethod', to_jsonb(lt."accrual_method"),
			'accrualDay', to_jsonb(lt."accrual_day"),
			'accrualUnconfigured', to_jsonb(lt."accrual_unconfigured"),
			'policyMethods', COALESCE(
				(
					SELECT jsonb_agg(
						jsonb_build_object(
							'policyId', lp."id",
							'method', lp."accrual"->'method',
							'gradeId', lp."grade_id",
							'companyId', lp."company_id",
							'validFrom', lp."valid_from",
							'validTo', lp."valid_to"
						)
						ORDER BY lp."valid_from", lp."id"
					)
					FROM "leave_policy" lp
					WHERE lp."leave_type_id" = lt."id" AND lp."accrual" ? 'method'
				),
				'[]'::jsonb
			)
		),
		'after', jsonb_build_object(
			'accrualMethod', NULL,
			'accrualDay', NULL,
			'accrualUnconfigured', to_jsonb(now()),
			'policyMethods', '[]'::jsonb
		)
	)
FROM "leave_type" lt
WHERE lt."archived_at" IS NULL;--> statement-breakpoint

-- ── 2. SURFACE 1: leave_type ─────────────────────────────────────────────────────────────────────────
--
-- Unconditional over every non-archived type, including the 15 that already read NULL. The marker is the
-- point, not the NULL: a type whose method was already absent was reading as the LUMP path, which is the
-- over-grant this reset exists to prevent. "Already clear" and "explicitly not configured" are different
-- states and only the second one is safe.
--
-- ARCHIVED TYPES ARE DELIBERATELY LEFT ALONE. Nothing grants them (every engine filters archived_at IS
-- NULL), so marking them would change no behaviour, and un-archiving one later should restore it as it
-- was rather than as a type someone has to reconfigure.
--
-- NOTE ON THE UNRULED FALL-THROUGH, which 0358 had to defend against and this does not: nulling
-- accrual_method here CAN flip a type to "unruled" (hasAnyLeaveTypeRule is a NULL test and this marker is
-- deliberately excluded from it), which would normally restore the legacy JSONB rule set verbatim. It is
-- harmless HERE only because statement 3 removes the earning half of that legacy set in the same
-- transaction, and because the marker gates every granting path ahead of method resolution anyway. The
-- carry / rounding / max-balance halves of the JSONB are untouched and still fall through exactly as they
-- did before this migration — which is correct, because this reset does not touch those settings.
UPDATE "leave_type" SET
	"accrual_method" = NULL,
	"accrual_day" = NULL,
	"accrual_unconfigured" = now()
WHERE "archived_at" IS NULL;--> statement-breakpoint

-- ── 3. SURFACE 2: leave_policy.accrual ───────────────────────────────────────────────────────────────
--
-- The 57 rows the counts found, plus the 10 lump ones. ONLY the 'method' key is removed; annualDays,
-- serviceBands, every carry key, roundingMethod and maxBalanceDays stay exactly as they are, and the `-`
-- is a no-op on a policy that never carried a method.
--
-- Rows for ARCHIVED types are cleared too, unlike statement 2 — and the asymmetry is intentional. The
-- leave_type row is the thing an administrator un-archives and expects back as it was; these JSONB copies
-- are the duplicated second surface this item exists to silence, and leaving them would let a re-archived
-- type resurrect an earning method through the fall-through path.
UPDATE "leave_policy"
SET "accrual" = "accrual" - 'method'
WHERE "accrual" ? 'method';
