-- Fix: app.consume_invitation raised "column reference tenant_id is ambiguous" whenever the invitation
-- targeted an existing person.
--
-- The function is declared RETURNS TABLE (app_user_id uuid, tenant_id uuid). Those OUT parameters are
-- in scope as PL/pgSQL variables for the whole body, so the unqualified `tenant_id` in
--
--     SELECT id INTO v_user_id FROM app_user WHERE tenant_id = ... AND person_id = ...
--
-- was ambiguous between the OUT parameter and app_user.tenant_id, and Postgres refused to plan it.
--
-- Blast radius: that SELECT only runs inside `IF v_inv.person_id IS NOT NULL`, i.e. ONLY when inviting
-- someone already linked to a person record. Invitations with no person_id skipped the branch entirely,
-- which is why this survived — test/auth.test.ts only ever invited by email with no personId, so the
-- branch was never planned. Inviting an existing employee has been broken since 0151.
--
-- This is the exact path a real-auth cutover depends on: binding a live WorkOS subject onto the app_user
-- of a seeded/existing person. It would have failed at the worst possible moment.
--
-- The fix is a table alias so the column is unambiguous. Everything else is byte-identical to 0151 —
-- same signature, same single-use semantics, same grants (CREATE OR REPLACE preserves them).
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
