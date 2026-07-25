-- Slice 0 — close the invitation privilege-escalation seam (ADR-0077 program, findings F3/F18).
--
-- THE HOLE
-- --------
-- Two facts combined into a tenant-wide escalation that `test/invitation-privesc.test.ts` reproduces
-- against the pre-migration tree (5 exploits succeed):
--
--   1. `app_invitation_rls`'s WITH CHECK (0151:51-53) carries NO role conjunct — it asks only
--      `app.is_admin_for(coalesce(company_id, id))`. A COMPANY-SCOPED hr_admin, who under
--      `role_assignment_write` (0295:66-82) may grant ONLY `hr_admin` inside its own subtree, could
--      therefore write an invitation for ANY role — `super_admin`, or even `operator`.
--   2. `app.consume_invitation` is SECURITY DEFINER (0281) and inserts `v_inv.role` into
--      `role_assignment` uncritically (0151:158-159). `role_assignment` is not FORCE-RLS, so the
--      definer runs as owner and 0295's matrix NEVER EVALUATES. The invitation seam was a way to
--      write a grant that the grant table itself would have refused.
--
-- The escalation lands because `app.is_group_admin()` (0016:38-44) is true for ANY `super_admin`
-- grant regardless of company scope — so a company-scoped admin that minted itself a company-scoped
-- `super_admin` became a GROUP admin.
--
-- `core/auth.ts` (ROLES set + assertGroupAdmin) guards the one TypeScript call site, which is why
-- this was not reachable through the invite screen. That is a call site; this is the boundary.
--
-- WHAT THIS MIGRATION DOES — three independent layers, in increasing order of bluntness
-- ------------------------------------------------------------------------------------
--   1. RLS WITH CHECK: the invitation seam now enforces the SAME matrix as role_assignment_write.
--      An invitation can no longer express a grant its creator could not have written directly.
--   2. CHECK constraint: `role` must be a CUSTOMER role, enforced against EVERY writer including
--      ai_hr_owner. Safe because operator grants are never invited — 0294's header is explicit:
--      "Operator grants are inserted by ai_hr_owner only (the seed for dev, by hand on a
--      deployment)". Verified VALIDATED-safe: zero app_invitation rows exist on dev or the live
--      deployment at the time of writing, so the constraint validates without a scan failure.
--   3. consume_invitation re-validates the stored row's STATIC shape before granting — the backstop
--      for a row that predates layers 1 and 2 on a deployment this migration has not seen.
--
-- WHAT IS DELIBERATELY *NOT* CHECKED AT CONSUME (a correction to the slice plan)
-- -----------------------------------------------------------------------------
-- The plan called for consume to also refuse "company-scoped rows unless hr_admin". That rule is
-- WRONG and would break a legitimate path: 0295's group branch (`app.is_group_admin()`) permits a
-- group admin to grant ANY customer role at ANY scope, including a company-scoped `manager`. At
-- consume time the session belongs to the INVITEE (or to the definer), so the inviter-context
-- conjuncts — `is_group_admin()`, `is_admin_for(company_id)` — are not re-evaluable; only static
-- facts about the row are. Consume therefore checks exactly what is static and unambiguous: the role
-- is a real customer role and is not `operator`. Everything context-dependent stays in the WITH
-- CHECK, which runs while the inviter's session is live.

-- ── 1. The seam enforces role_assignment_write's matrix (0295:66-82) ─────────────────────────────
--
-- `app_invitation.role` is TEXT (db/schema.ts), not the `role` enum, so these are plain text
-- comparisons — 0295's "never cast a literal to ::role" discipline is satisfied trivially here.
--
-- USING is left as scope-only, matching the pre-existing policy: an admin may still READ and revoke
-- any invitation in its tenant. Only the WRITE path is tightened.
--
-- The `role <> 'operator'` conjunct is redundant against layer 2's CHECK constraint and is kept
-- anyway, mirroring 0295's explicit style: the two layers are independently reviewable, and a future
-- edit that relaxes the constraint must not silently reopen the policy.
DROP POLICY app_invitation_rls ON app_invitation;
--> statement-breakpoint
CREATE POLICY app_invitation_rls ON app_invitation FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND role <> 'operator'
    AND (
      app.is_group_admin()
      OR (role = 'hr_admin' AND company_id IS NOT NULL AND app.is_admin_for(company_id))
    )
  );
--> statement-breakpoint

-- ── 2. `role` must name a CUSTOMER role — binds ai_hr_owner too ──────────────────────────────────
--
-- The enum's labels are employee, manager, hr_admin, super_admin, payroll_partner,
-- performance_comp_partner, operator. Everything except `operator` is invitable. Listing them as
-- text literals (rather than casting the column to ::role) keeps this constraint independent of the
-- enum's evolution: adding a label to `role` does NOT silently make it invitable — a later migration
-- has to say so here, which is the reviewable outcome.
--
-- This also rejects garbage: `role` is a free TEXT column, so 'root' or '' were previously storable
-- and would have reached `v_inv.role::role` at consume as a runtime cast error rather than a policy
-- decision.
ALTER TABLE app_invitation
  ADD CONSTRAINT app_invitation_role_customer_set
  CHECK (role IN ('employee', 'manager', 'hr_admin', 'super_admin', 'payroll_partner', 'performance_comp_partner'));
--> statement-breakpoint

-- ── 3. consume_invitation: static re-validation before the grant is written ──────────────────────
--
-- Unchanged from 0281 except for the guard block marked below. The function stays SECURITY DEFINER
-- (it must create the app_user and the grant for a caller who has no session yet) — which is exactly
-- why it has to police its own input.
CREATE OR REPLACE FUNCTION app.consume_invitation(p_raw_token text, p_subject text)
  RETURNS TABLE (app_user_id uuid, tenant_id uuid)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_hash text := encode(sha256(convert_to(p_raw_token, 'UTF8')), 'hex');
  v_inv  app_invitation%ROWTYPE;
  v_user_id uuid;
BEGIN
  -- Atomic single-use claim: only a still-pending, unexpired invitation flips to accepted; a concurrent
  -- second consume of the same token affects 0 rows and drops through to the NOT FOUND branch.
  UPDATE app_invitation
     SET status = 'accepted', accepted_at = now()
   WHERE token_hash = v_hash AND status = 'pending' AND expires_at > now()
  RETURNING * INTO v_inv;

  IF NOT FOUND THEN
    RETURN; -- unknown / already-consumed / expired token → 0 rows (caller throws InvalidInvitation)
  END IF;

  -- ── SLICE-0 GUARD ──────────────────────────────────────────────────────────────────────────────
  -- The last line of defence for a row that predates the WITH CHECK and the CHECK constraint above.
  -- STATIC facts only (see this file's header for why inviter-context conjuncts cannot be re-checked
  -- here). The RAISE aborts the transaction, so the `status = 'accepted'` flip above is rolled back
  -- too — a refused invitation is left pending rather than silently burned, and the refusal is
  -- visible in the log instead of manifesting as a mysterious missing grant.
  IF v_inv.role = 'operator' THEN
    RAISE EXCEPTION 'invitation refused: the operator role is not grantable by invitation (invitation %)', v_inv.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_inv.role NOT IN ('employee', 'manager', 'hr_admin', 'super_admin', 'payroll_partner', 'performance_comp_partner') THEN
    RAISE EXCEPTION 'invitation refused: % is not a valid customer role (invitation %)', v_inv.role, v_inv.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- ── END SLICE-0 GUARD ──────────────────────────────────────────────────────────────────────────

  -- Create or link the app_user for this subject. If a person was targeted and already has an app_user,
  -- attach the subject to it; otherwise insert a new one. workos_user_id is globally unique, so a subject
  -- already bound to another user makes this fail loudly (correct: one subject = one user).
  IF v_inv.person_id IS NOT NULL THEN
    -- Aliased (u.) — an unqualified tenant_id here collides with the RETURNS TABLE OUT parameter.
    SELECT u.id INTO v_user_id
      FROM app_user u
     WHERE u.tenant_id = v_inv.tenant_id AND u.person_id = v_inv.person_id
     LIMIT 1;
  END IF;

  IF v_user_id IS NULL THEN
    INSERT INTO app_user (tenant_id, workos_user_id, person_id)
    VALUES (v_inv.tenant_id, p_subject, v_inv.person_id)
    RETURNING id INTO v_user_id;
  ELSE
    UPDATE app_user SET workos_user_id = p_subject WHERE id = v_user_id;
  END IF;

  INSERT INTO role_assignment (tenant_id, app_user_id, company_id, role)
  VALUES (v_inv.tenant_id, v_user_id, v_inv.company_id, v_inv.role::role);

  RETURN QUERY SELECT v_user_id, v_inv.tenant_id;
END;
$$;
