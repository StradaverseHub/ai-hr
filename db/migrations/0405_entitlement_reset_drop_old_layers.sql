-- 6e9a126e RELEASE THREE — archive, then clear the two old entitlement layers.
--
-- ⚠️ THIS IS THE IRREVERSIBLE ONE. It deletes every piece of entitlement configuration the customer has,
-- and the only thing standing between them and having to remember it is the archive captured six lines
-- below. Read this whole header before changing a character of it.
--
-- ── WHAT THE REPORTER AGREED TO, IN WRITING ──────────────────────────────────────────────────────────
-- "The Benefit Scheme step, the years-worked step inside it, and the older company and grade entitlement
--  rules are all removed, and everything currently configured in them is cleared. You reconfigure from a
--  blank page, as you asked." And: "It is irreversible: the written record is a listing to retype from,
--  not an undo button."
--
-- Measured on production 2026-08-06, immediately before this was written:
--   benefit_scheme 41 · scheme_leave_entitlement 292 · leave_policy 67  =  the plan's 359 pieces to retype
--   entitlement_template 0 · entitlement_eligibility_rule 0             =  the new layer, still empty
--
-- ── WHY THE CAPTURE COMES FIRST, AND WHY IT IS RE-TAKEN ──────────────────────────────────────────────
-- An archive already exists, tagged '0398-release-one', 361 rows, taken 2026-08-05. IT IS STALE — it
-- predates r160/r161/r162 and any configuration change since. The plan is explicit that "the
-- completeness of that written record is the only promise the clearing makes", so this re-captures under
-- its own tag in the SAME transaction as the drops. If the capture fails, nothing is dropped.
--
-- app.capture_entitlement_reset_archive() is the same function core/entitlement-archive.ts calls, and the
-- listing at /admin/leave/entitlements/archive reads what it writes. Calling the function rather than
-- restating its SELECTs here is deliberate: two copies of "what the archive contains" is exactly how a
-- record ends up missing a column nobody noticed.
--
-- ── DROP ORDER IS FORCED BY THE FOREIGN KEYS, verified against information_schema ────────────────────
-- Only benefit_scheme has dependants: scheme_leave_entitlement.benefit_scheme_id and
-- employment.benefit_scheme_id. Both must go first. leave_policy has NO dependants at all.
-- employment.benefit_scheme_id is already 0 rows on production, so that column carries no data.
--
-- ── WHAT DELIBERATELY SURVIVES ───────────────────────────────────────────────────────────────────────
-- grade_group and grade_group_member. 205 live leave_approval_policy rows scope by them; dropping them
-- would silently unscope every one of those rules and force the customer to rebuild each by hand. They
-- stay as plain organisation grade banding. This is called out in the plan's business half as the one
-- thing that is NOT cleared, and it is the single most expensive mistake available in this file.
--
-- No GRANT is needed: nothing is created.

-- 1. RE-CAPTURE. Fails loud, before anything is destroyed.
SELECT app.capture_entitlement_reset_archive('0405-release-three');--> statement-breakpoint

-- 2. Say what was captured, so the numbers land in the deploy log and can be read back against the
--    figures the reporter was given.
DO $$
DECLARE
  v_scheme  integer;
  v_policy  integer;
  v_archive integer;
BEGIN
  SELECT count(*) INTO v_scheme  FROM scheme_leave_entitlement;
  SELECT count(*) INTO v_policy  FROM leave_policy;
  SELECT count(*) INTO v_archive FROM entitlement_reset_archive WHERE capture_tag = '0405-release-three';
  RAISE NOTICE '0405 entitlement reset: % scheme entitlement tables + % policy rows cleared; % rows archived under 0405-release-three',
    v_scheme, v_policy, v_archive;
  -- THE GUARD IS CONDITIONAL ON THERE BEING SOMETHING TO CAPTURE, and getting this wrong aborted the
  -- whole migration chain on a FRESH database — caught by running migrate+seed on a rebuilt cluster,
  -- not by any gate that only ever migrates a populated one.
  --
  -- On production there are 41 schemes / 292 entitlement tables / 67 policy rows, so an archive of 0
  -- means the capture silently failed and refusing is exactly right — that archive is the only promise
  -- the clearing makes. On an EMPTY database (a new tenant, the clean-room, the upgrade rehearsal's
  -- fresh leg) 0 captured is the TRUTHFUL answer, and the unconditional check turned it into
  -- "0405 refusing to clear", which no new tenant could ever get past.
  IF (v_scheme + v_policy) > 0 AND v_archive = 0 THEN
    RAISE EXCEPTION '0405 refusing to clear: % scheme + % policy rows exist but the archive capture wrote none',
      v_scheme, v_policy;
  END IF;
END $$;--> statement-breakpoint

-- 3. Clear. Children before parents; leave_policy last because it stands alone.
DROP TABLE IF EXISTS scheme_leave_entitlement;--> statement-breakpoint
ALTER TABLE employment DROP COLUMN IF EXISTS benefit_scheme_id;--> statement-breakpoint
DROP TABLE IF EXISTS benefit_scheme;--> statement-breakpoint
DROP TABLE IF EXISTS leave_policy;
