# Draft discard port — revised NONEXECUTABLE SQL review proposal

Root corrections incorporated in this private revision; independent review and integration gaps remain. NOT approved or executable. Review material only. None of these fenced statements has been applied. This is NOT a migration, bootstrap change, provisioning authorization or installation instruction. Dedicated non-table-owner NOLOGIN role is the selected design; no canonical-policy copies or alternative proof architecture are proposed. All private columns/policy/function/role names below remain proposed, unallocated identifiers. Existing action-kind/CHECK/retirement/proof integration is deliberately not claimed implemented.

Sources: deploy/bootstrap-db.sql:59 creates ai_hr_owner NOSUPERUSER NOCREATEROLE; 0510 owns native draft author/company policy; 0579 adds restrictive TO ai_hr_app draft RLS/triggers and its session/effective-role owner exception; 0622:141 closes raw review/content grants; 0714 activation command must keep its API/grants/completion/body behavior.

PostgreSQL 16 syntax checked against official [GRANT](https://www.postgresql.org/docs/16/sql-grant.html) and [ALTER FUNCTION](https://www.postgresql.org/docs/16/sql-alterfunction.html) documentation. Membership accepts one option per statement; ownership transfer requires SET access to the target role and its schema CREATE privilege.

## 1. Future operator prerequisite — NOT authorized

Only a separately authorized role-management operator could provision this prerequisite. ai_hr_owner cannot create it. Existing-role reconciliation must inspect attributes/membership graph and refuse incompatible state; no silent CREATE-if-missing privilege assumption.

```sql
-- FUTURE OPERATOR-OWNED, NONEXECUTED PROPOSAL ONLY.
CREATE ROLE ai_hr_draft_discard_port
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;

-- One-way native-policy/privilege inheritance; each PG16 option is explicit.
GRANT ai_hr_app TO ai_hr_draft_discard_port WITH INHERIT TRUE;
GRANT ai_hr_app TO ai_hr_draft_discard_port WITH SET FALSE;
GRANT ai_hr_app TO ai_hr_draft_discard_port WITH ADMIN FALSE;

-- Ownership-transfer capability for the existing restricted migration owner.
GRANT ai_hr_draft_discard_port TO ai_hr_owner WITH INHERIT FALSE;
GRANT ai_hr_draft_discard_port TO ai_hr_owner WITH SET TRUE;
GRANT ai_hr_draft_discard_port TO ai_hr_owner WITH ADMIN FALSE;
```

There must be no direct or transitive edge allowing ai_hr_app to inherit or SET the child role, and no child path to ai_hr_owner/platform/table owners/BYPASSRLS roles. The owner-to-child edge above does not imply the reverse. Audit pg_auth_members inherit_option/set_option/admin_option and all alternate paths; do not infer safety from direct edges only. Final operator retention/removal of migration-owner SET membership is an explicit deployment decision. No role-management changes are included in a future ordinary schema migration by assumption.

## 2. Proposed private columns and privileges

These column definitions illustrate the exact privilege surface, not a complete kind-admission migration. Existing adapter columns and constraints remain unchanged. Source digest, source_xmin and source_ctid are populated ONLY by the future closed prepare owner from the same actual bounded full source snapshot; no app-supplied revision or digest is accepted. The DELETE port may update only the two deletion witness columns. ctid is an additional private source-version binding; the tagged content hash still covers exactly thirteen stored fields plus xmin.

```sql
-- PROPOSED NAMES; NOT allocated/executable migration content.
ALTER TABLE app.assistant_own_leave_review
  ADD COLUMN draft_discard_source_digest text,
  ADD COLUMN draft_discard_source_xmin text,
  ADD COLUMN draft_discard_source_ctid tid,
  ADD COLUMN draft_discard_deleted_digest text,
  ADD COLUMN draft_discard_delete_xid xid8;

-- Complete all-null/complete witness shape, hex validation and new-kind-only
-- constraints still require assembly with the final generic CHECK ownership.
-- No app raw ledger grants are added.
GRANT USAGE ON SCHEMA app TO ai_hr_draft_discard_port;
GRANT SELECT (
  action_kind,id,tenant_id,user_id,person_id,company_id,
  receipt_subject_kind,receipt_subject_id,state,expires_at,
  draft_discard_source_digest,draft_discard_source_xmin,draft_discard_source_ctid,
  draft_discard_deleted_digest,draft_discard_delete_xid
) ON app.assistant_own_leave_review TO ai_hr_draft_discard_port;
GRANT UPDATE (draft_discard_deleted_digest,draft_discard_delete_xid)
  ON app.assistant_own_leave_review TO ai_hr_draft_discard_port;
```

No review-content privilege is needed for this stamp: completed proof still independently requires pending body presence before completion. The protected prepare owner creates body and metadata atomically; retirement cannot turn body absence into success. If independent review requires stamp-time body presence, that is a separately reviewed SELECT(action_id)-only policy/grant; never ciphertext/kid/wrapped_dek. This prototype grants none.

The role already inherits native employee_draft SELECT/DELETE privileges through ai_hr_app. Do not add a new employee_draft policy or a policy-body copy. RLS on the hidden ledger needs its own narrow port-role policy because inherited app has no raw ledger access.

```sql
CREATE POLICY draft_discard_port_read ON app.assistant_own_leave_review
FOR SELECT TO ai_hr_draft_discard_port
USING (
  action_kind='employees.draft.discard'
  AND receipt_subject_kind='employee_draft'
  AND receipt_subject_id IS NOT NULL
  AND tenant_id=app.current_tenant_id()
  AND user_id=app.current_user_id()
  AND state='awaiting_confirmation'
  AND expires_at>pg_catalog.clock_timestamp()
  AND app.is_admin()
  AND app.principal_snapshot_current()
  AND EXISTS (
    SELECT 1 FROM public.app_user a
    WHERE a.id=app.current_user_id() AND a.tenant_id=app.current_tenant_id()
      AND a.archived_at IS NULL AND NOT app.login_blocked(a.id)
      AND a.person_id IS NOT DISTINCT FROM assistant_own_leave_review.person_id
  )
);

CREATE POLICY draft_discard_port_stamp ON app.assistant_own_leave_review
FOR UPDATE TO ai_hr_draft_discard_port
USING (
  assistant_own_leave_review.action_kind='employees.draft.discard'
  AND assistant_own_leave_review.receipt_subject_kind='employee_draft'
  AND assistant_own_leave_review.tenant_id=app.current_tenant_id()
  AND assistant_own_leave_review.user_id=app.current_user_id()
  AND assistant_own_leave_review.state='awaiting_confirmation'
  AND assistant_own_leave_review.expires_at>pg_catalog.clock_timestamp()
  AND assistant_own_leave_review.draft_discard_deleted_digest IS NULL
  AND assistant_own_leave_review.draft_discard_delete_xid IS NULL
  AND app.is_admin()
  AND app.principal_snapshot_current()
  AND EXISTS (SELECT 1 FROM public.app_user a
    WHERE a.id=app.current_user_id() AND a.tenant_id=app.current_tenant_id()
      AND a.archived_at IS NULL AND NOT app.login_blocked(a.id)
      AND a.person_id IS NOT DISTINCT FROM assistant_own_leave_review.person_id)
)
WITH CHECK (
  assistant_own_leave_review.action_kind='employees.draft.discard'
  AND assistant_own_leave_review.receipt_subject_kind='employee_draft'
  AND assistant_own_leave_review.tenant_id=app.current_tenant_id()
  AND assistant_own_leave_review.user_id=app.current_user_id()
  AND assistant_own_leave_review.state='awaiting_confirmation'
  AND assistant_own_leave_review.expires_at>pg_catalog.clock_timestamp()
  AND assistant_own_leave_review.draft_discard_deleted_digest IS NOT NULL
  AND assistant_own_leave_review.draft_discard_deleted_digest
      =assistant_own_leave_review.draft_discard_source_digest
  AND assistant_own_leave_review.draft_discard_delete_xid=pg_current_xact_id()
  AND app.is_admin()
  AND app.principal_snapshot_current()
  AND EXISTS (SELECT 1 FROM public.app_user a
    WHERE a.id=app.current_user_id() AND a.tenant_id=app.current_tenant_id()
      AND a.archived_at IS NULL AND NOT app.login_blocked(a.id)
      AND a.person_id IS NOT DISTINCT FROM assistant_own_leave_review.person_id)
);
```

UPDATE USING examines an unstamped OLD row; WITH CHECK permits the stamped NEW row. Do not mistakenly require NULL witness in both halves. SELECT policy must permit the updated stamped pending row too. Every outer ledger reference is explicitly qualified in correlated principal checks; otherwise an inner app_user.person_id could make a binding check vacuous.

## 3. Fixed actual-DELETE port

No application input supplies a source digest, action ID, raw row, witness, XID, SQL or relation name. The port accepts only the native selected draft UUID. Ordinary native discard uses this SAME physical DELETE. Existing invoker reservation release/audit remain their actual native owners. Raw activation retains its raw DELETE and receives NO discard stamp. An independent generic actual-DELETE deferred trigger cleans ALL remaining draft review custody, regardless of whether the deletion came through this port or activation.

```sql
CREATE FUNCTION app.native_employee_draft_discard_delete(p_draft uuid)
RETURNS TABLE (deleted_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
SET row_security=on
AS $port$
DECLARE
  deleted record;
  source_bytes bytea;
  source_digest text;
  affected integer;
  actual_columns text[];
  capture_found boolean:=false;
  candidate record;
  candidate_id uuid;
  candidate_company uuid;
  candidate_digest text;
  candidate_xmin text;
  candidate_ctid tid;
  source_shape_ok boolean;
BEGIN
  -- Evaluated INSIDE the actual SECURITY DEFINER execution role.
  IF current_user<>'ai_hr_draft_discard_port'
     OR NOT pg_catalog.row_security_active('public.employee_draft'::regclass)
     OR NOT pg_catalog.row_security_active('app.assistant_own_leave_review'::regclass)
  THEN RAISE EXCEPTION 'Draft delete role unavailable' USING ERRCODE='42501'; END IF;

  -- The existing Access barrier serializes admission and deferred retirement; no new key.
  PERFORM app.access_workforce_write_lock();
  -- Lock exact current USER pending metadata BEFORE deletion; never an unlocked EXISTS.
  -- One-per-kind/USER/draft partial uniqueness remains required. A second candidate fails closed.
  FOR candidate IN
    SELECT r.id,r.company_id,r.draft_discard_source_digest,
           r.draft_discard_source_xmin,r.draft_discard_source_ctid
    FROM app.assistant_own_leave_review r
    WHERE r.action_kind='employees.draft.discard'
      AND r.receipt_subject_kind='employee_draft' AND r.receipt_subject_id=p_draft
      AND r.tenant_id=app.current_tenant_id() AND r.user_id=app.current_user_id()
      AND r.state='awaiting_confirmation' AND r.expires_at>pg_catalog.clock_timestamp()
      AND r.draft_discard_source_digest IS NOT NULL
      AND r.draft_discard_source_xmin IS NOT NULL
      AND r.draft_discard_source_ctid IS NOT NULL
      AND r.draft_discard_deleted_digest IS NULL AND r.draft_discard_delete_xid IS NULL
      AND app.is_admin()
    ORDER BY r.id FOR UPDATE NOWAIT
  LOOP
    IF capture_found THEN
      RAISE EXCEPTION 'Draft review identity unavailable' USING ERRCODE='42501';
    END IF;
    capture_found:=true;
    candidate_id:=candidate.id; candidate_company:=candidate.company_id;
    candidate_digest:=candidate.draft_discard_source_digest;
    candidate_xmin:=candidate.draft_discard_source_xmin;
    candidate_ctid:=candidate.draft_discard_source_ctid;
  END LOOP;

  -- Schema drift disables proof capture, never the ordinary native GUI DELETE.
  SELECT pg_catalog.array_agg(a.attname::text ORDER BY a.attnum) INTO actual_columns
  FROM pg_catalog.pg_attribute a
  WHERE a.attrelid='public.employee_draft'::regclass
    AND a.attnum>0 AND NOT a.attisdropped;
  -- IMPORTANT: physical order must be verified from the eventual deployment catalog.
  -- Compare sorted names here to avoid making ORM declaration order a physical-order assumption.
  source_shape_ok := (SELECT pg_catalog.array_agg(n ORDER BY n) FROM pg_catalog.unnest(actual_columns) n) IS NOT DISTINCT FROM
     (SELECT pg_catalog.array_agg(n ORDER BY n) FROM pg_catalog.unnest(ARRAY[
       'id','tenant_id','company_id','created_by_person_id','label','data','current_step',
       'reserved_employee_code','reserved_at','reserved_config_id','reserved_number',
       'created_at','updated_at']::text[]) n);

  -- Canonical Access/Lifecycle interval is owned by the surrounding native owner/design.
  -- No parallel key or app marker. Native RLS and draft triggers execute on THIS DELETE.
  DELETE FROM public.employee_draft AS d
  WHERE d.id=p_draft
  RETURNING d.*,d.xmin::text AS source_xmin,d.ctid AS source_ctid INTO deleted;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft delete not found' USING ERRCODE='P0002';
  END IF;

  -- Cheap tuple-version rejection BEFORE allocating/encoding the private row commitment.
  -- Same-XID UPDATEs change ctid; xmin alone does not identify that source version.
  IF NOT capture_found OR NOT source_shape_ok
     OR deleted.source_xmin IS DISTINCT FROM candidate_xmin
     OR deleted.source_ctid IS DISTINCT FROM candidate_ctid
     OR deleted.company_id IS DISTINCT FROM candidate_company THEN
    RETURN QUERY SELECT deleted.id::uuid;
    RETURN;
  END IF;
  -- Domain/version plus fourteen exact OLD values. UTC microseconds are session-independent.
  source_bytes:=pg_catalog.convert_to(pg_catalog.jsonb_build_array('native-employee-draft-row:v1',pg_catalog.jsonb_build_array(
    deleted.id,deleted.tenant_id,deleted.company_id,deleted.created_by_person_id,
    deleted.label,deleted.data,deleted.current_step,deleted.reserved_employee_code,
    pg_catalog.to_char(deleted.reserved_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    deleted.reserved_config_id,deleted.reserved_number,
    pg_catalog.to_char(deleted.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    pg_catalog.to_char(deleted.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    deleted.source_xmin
  ))::text,'UTF8');
  IF pg_catalog.octet_length(source_bytes)>1048576 THEN
    -- Native deletion still succeeds without proof; Assistant must refuse missing stamp and rollback.
    RETURN QUERY SELECT deleted.id::uuid;
    RETURN;
  END IF;
  source_digest:=pg_catalog.encode(pg_catalog.sha256(source_bytes),'hex');

  -- Native GUI calls can have no matching current-user review. That is not an error.
  -- Source digest includes actual deleted OLD fields+xmin; a prior SELECT cannot stamp.
  UPDATE app.assistant_own_leave_review AS r
  SET draft_discard_deleted_digest=source_digest,
      draft_discard_delete_xid=pg_current_xact_id()
  WHERE r.id=candidate_id
    AND r.action_kind='employees.draft.discard'
    AND r.receipt_subject_kind='employee_draft'
    AND r.receipt_subject_id=deleted.id
    AND r.tenant_id=deleted.tenant_id AND r.tenant_id=app.current_tenant_id()
    AND r.user_id=app.current_user_id()
    AND r.company_id IS NOT DISTINCT FROM deleted.company_id
    AND r.state='awaiting_confirmation' AND r.expires_at>pg_catalog.clock_timestamp()
    AND r.draft_discard_source_digest=candidate_digest
    AND candidate_digest=source_digest
    AND r.draft_discard_source_xmin=candidate_xmin
    AND r.draft_discard_source_ctid=candidate_ctid
    AND r.draft_discard_deleted_digest IS NULL AND r.draft_discard_delete_xid IS NULL;
  GET DIAGNOSTICS affected=ROW_COUNT;
  IF affected>1 THEN
    RAISE EXCEPTION 'Draft review identity unavailable' USING ERRCODE='42501';
  END IF;

  RETURN QUERY SELECT deleted.id::uuid;
END;
$port$;
REVOKE ALL ON FUNCTION app.native_employee_draft_discard_delete(uuid) FROM PUBLIC,ai_hr_app;
```

Capture eligibility is not a new native DELETE permission: the current-HR predicate only gates review stamping. The prelocked candidate row is the only possible stamp target; its later UPDATE does not discover or wait for another user's review row. Port RLS requires current app.is_admin() in addition to fresh USER/PERSON checks: native raw non-HR author DELETE rights remain governed by existing employee_draft RLS, but losing HR cannot stamp an older HR review. No new employee_draft HR policy is added.

The port's dedicated P0002 missing/invisible deletion error must be mapped by the exact native discard wrapper only to its existing `Draft not found (or not visible).` error. Match the known port operation/SQLSTATE; do not broadly catch 42501, unrelated P0002 operations, counter failures or audit failures. This preserves native caller behavior while the port itself fails on zero deleted rows. No such wrapper integration is implemented here.

Capture-only schema/size checks above do not intentionally refuse native GUI deletion. A changed-schema or tuple-version-mismatched source returns the native deleted ID without encoding the full row and without a stamp. A matched version is safe to encode only if the closed prepare owner actually bounded that exact snapshot and stored digest+xmin+ctid atomically; a forged or caller-computed revision would invalidate this argument. The defensive post-encoding ceiling remains but is not the primary memory bound. Assistant completion independently requires the stamp and therefore refuses/rolls back its enclosing transaction. PostgreSQL may still materialize RETURNING d.* or an unusually large individual datum before procedural comparisons. This document does NOT prove an absolute memory/TOAST bound or unconditional large-GUI success. Native GUI progress for that case remains an explicit execution-engine/owner review question; if actual RETURNING materialization cannot be made safe, do not claim it is guaranteed.

Both source preparation and port must adopt the exact tagged UTC-microsecond encoding shown; no independently chosen stringify/date representation. The one-MiB ceiling covers this serialized private proof input, not native draft eligibility. Deleted xmin is source revision, not deletion XID. No event/counter proof is claimed by the port stamp alone.

### Closed prepare owner: same-snapshot prerequisite (not an implemented endpoint)

The future prepare owner must lock the actual native-authorized draft and derive all three private fields from ONE captured SQL row/revision. A client/controller must never pass these values into a generic metadata setter. The following is the required fixed-source fragment inside that closed owner, not a callable app function and not a proposal to grant source-column UPDATE to the child:

```sql
-- Scope/permission must already be the independently reviewed native RLS source owner.
-- Do NOT run a table-owner bypass read and substitute copied native policy text.
SELECT d.*,d.xmin::text AS source_xmin,d.ctid AS source_ctid
INTO prepared_source
FROM public.employee_draft d
WHERE d.id=p_draft AND d.tenant_id=app.current_tenant_id()
FOR UPDATE NOWAIT;
-- From this ONE row: check expected complete schema; compute the exact same tagged
-- UTC-microsecond fourteen-part serialized byte string shown in the DELETE port;
-- establish the one-MiB bound before accepting a prepared binding, then compute its digest.
-- Insert the source digest, prepared_source.source_xmin and prepared_source.source_ctid
-- together with the exact same draft/company/USER binding and body in the protected review row.
-- If any part fails, roll back preparation: no partially populated metadata/body.
```

This is an explicit integration prerequisite. The existing unmounted contract has no such SQL-owned prepare implementation, and this document does not create one or add a new helper/privilege architecture. Which already-reviewed native RLS source-owner context executes this fragment must be settled before executable SQL; actual prepare, revision storage and port encoding require independent source review together. No safety claim is based on client-supplied xmin/ctid. Preparation's own read/serialization memory bound remains to be demonstrated; a post-allocation length test alone is insufficient.

## 4. Invoker witness guard — no runtime queries

This guard must be SECURITY INVOKER. A SECURITY DEFINER trigger would observe the trigger owner's current_user and could not distinguish the child port from other callers. It uses OLD/NEW/current_user/TG_ARGV only, with no ledger/content/privacy/cross-domain query. Direct app raw writes remain denied independently by grants/RLS. TG_ARGV[0] is the actual ledger-owner role captured at installation, not a caller parameter or assumed postgres name.

```sql
CREATE FUNCTION app.guard_draft_discard_delete_witness()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp
AS $guard$
DECLARE
  old_empty boolean;
  new_empty boolean;
  stable_binding boolean;
BEGIN
  new_empty:=NEW.draft_discard_deleted_digest IS NULL
             AND NEW.draft_discard_delete_xid IS NULL;
  IF TG_OP='INSERT' THEN
    IF NOT new_empty THEN RAISE EXCEPTION 'Initial deletion witness forbidden' USING ERRCODE='42501';END IF;
    RETURN NEW;
  END IF;
  old_empty:=OLD.draft_discard_deleted_digest IS NULL
             AND OLD.draft_discard_delete_xid IS NULL;
  stable_binding:=ROW(NEW.action_kind,NEW.id,NEW.tenant_id,NEW.user_id,NEW.person_id,
                     NEW.company_id,NEW.receipt_subject_kind,NEW.receipt_subject_id)
    IS NOT DISTINCT FROM
                 ROW(OLD.action_kind,OLD.id,OLD.tenant_id,OLD.user_id,OLD.person_id,
                     OLD.company_id,OLD.receipt_subject_kind,OLD.receipt_subject_id);
  -- Existing closed owner retirement clears the complete private source+witness tuple,
  -- including ordinary pending reviews that never acquired a deletion stamp.
  IF stable_binding AND current_user=TG_ARGV[0]
     AND NEW.state IN ('discarded','expired','refused') THEN
    NEW.draft_discard_source_digest:=NULL;
    NEW.draft_discard_source_xmin:=NULL;
    NEW.draft_discard_source_ctid:=NULL;
    NEW.draft_discard_deleted_digest:=NULL;
    NEW.draft_discard_delete_xid:=NULL;
    new_empty:=true;
  END IF;
  IF OLD.action_kind='employees.draft.discard'
     AND ROW(NEW.draft_discard_source_digest,NEW.draft_discard_source_xmin,NEW.draft_discard_source_ctid)
         IS DISTINCT FROM ROW(OLD.draft_discard_source_digest,OLD.draft_discard_source_xmin,OLD.draft_discard_source_ctid)
     AND NOT (stable_binding AND current_user=TG_ARGV[0]
       AND NEW.draft_discard_source_digest IS NULL AND NEW.draft_discard_source_xmin IS NULL
       AND NEW.draft_discard_source_ctid IS NULL
       AND (NEW.state IN ('discarded','expired','refused')
            OR OLD.state='completed' AND NEW.state='completed'))
  THEN RAISE EXCEPTION 'Prepared source tuple immutable' USING ERRCODE='42501';END IF;
  IF NOT old_empty AND NOT stable_binding THEN
    RAISE EXCEPTION 'Deletion witness binding immutable' USING ERRCODE='42501';
  END IF;
  IF NOT old_empty AND NOT new_empty
     AND ROW(NEW.draft_discard_source_digest,NEW.draft_discard_source_xmin,NEW.draft_discard_source_ctid)
         IS DISTINCT FROM ROW(OLD.draft_discard_source_digest,OLD.draft_discard_source_xmin,OLD.draft_discard_source_ctid)
  THEN RAISE EXCEPTION 'Deletion source binding immutable' USING ERRCODE='42501';END IF;
  -- Reject even a no-op pending UPDATE: it would wash a child stamp's tuple xmin.
  IF NOT old_empty AND NEW.state='awaiting_confirmation' THEN
    RAISE EXCEPTION 'Pending deletion witness cannot be rewritten' USING ERRCODE='42501';END IF;
  IF ROW(NEW.draft_discard_deleted_digest,NEW.draft_discard_delete_xid)
     IS NOT DISTINCT FROM ROW(OLD.draft_discard_deleted_digest,OLD.draft_discard_delete_xid)
  THEN RETURN NEW; END IF;

  IF old_empty AND NOT new_empty
     AND current_user='ai_hr_draft_discard_port'
     AND stable_binding AND OLD.action_kind='employees.draft.discard'
     AND OLD.state='awaiting_confirmation' AND NEW.state=OLD.state
     AND ROW(NEW.draft_discard_source_digest,NEW.draft_discard_source_xmin,NEW.draft_discard_source_ctid)
         IS NOT DISTINCT FROM ROW(OLD.draft_discard_source_digest,OLD.draft_discard_source_xmin,OLD.draft_discard_source_ctid)
     AND NEW.draft_discard_deleted_digest=OLD.draft_discard_source_digest
     AND NEW.draft_discard_delete_xid=pg_current_xact_id()
  THEN RETURN NEW; END IF;

  -- Existing closed owner retirement/expiry and privacy paths may clear all proof atomically.
  -- No body/private queries here; canonical owners retain their existing audited admission checks.
  IF NOT old_empty AND new_empty AND stable_binding AND current_user=TG_ARGV[0]
     AND (NEW.state IN ('discarded','expired','refused')
          OR OLD.state='completed' AND NEW.state='completed')
  THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Deletion witness immutable' USING ERRCODE='42501';
END;
$guard$;
REVOKE ALL ON FUNCTION app.guard_draft_discard_delete_witness() FROM PUBLIC,ai_hr_app;
-- Trigger registration must pass the actual table-owner name, verified from catalog at assembly.
-- CREATE TRIGGER ... BEFORE INSERT OR UPDATE ON app.assistant_own_leave_review
-- FOR EACH ROW EXECUTE FUNCTION app.guard_draft_discard_delete_witness('<actual-ledger-owner>');
```

Remaining guard issue for concrete integration: the invoker guard above automatically clears witness fields during existing owner terminal retirement/expiry. Canonical completed-receipt erasure still needs additive clearing integration because existing erasure functions do not name these future columns. A completed-row owner UPDATE is NOT by itself proof of privacy admission. Because this invoker guard intentionally cannot query protected privacy intents, the canonical privacy owner/body-retirement hook must initiate the clear under its existing admission. No app marker or publicly callable clearer. Keep final proof CHECKs compatible with legitimate erased completed rows, whose historical recovery becomes unavailable.

The guard also needs final all-or-none source digest/xmin/ctid and witness/action-kind constraints. The source tuple is immutable for the life of the prepared binding and can be cleared only through canonical closed owner retirement/erasure integration. For stamping, both source revision fields must remain unchanged and match actual DELETE RETURNING; none are writable by the child role. Native xmin+ctid is version identity, not a permanent logical row ID. VACUUM FULL/table rewrite may cause a safe false-negative requiring fresh review.

The guard also needs final all-or-none witness/source-digest and action-kind constraints. Preserve every old kind and existing global erasure/expiry behavior; do not require witness columns on an erased completed receipt forever. Guard permits unchanged witness through canonical completion; completion itself must check top-XID before UPDATE.

## 5. Ownership transfer and final execution grant

Future installation transaction only, after operator prerequisites have been separately satisfied. This sequence must begin as the actual restricted migration owner; it cannot run inside SECURITY DEFINER code because PostgreSQL disallows SET ROLE there. This proposal leaves role restoration as an explicit reviewed operator step, not an invented automatic privilege.

```sql
-- FUTURE INSTALLATION SEQUENCE ONLY, NOT AUTHORIZED OR EXECUTED.
-- Under actual ai_hr_owner (the app schema owner), after PUBLIC execution revoked:
GRANT CREATE ON SCHEMA app TO ai_hr_draft_discard_port;
ALTER FUNCTION app.native_employee_draft_discard_delete(uuid)
  OWNER TO ai_hr_draft_discard_port;
REVOKE CREATE ON SCHEMA app FROM ai_hr_draft_discard_port;

-- Owner's membership is INHERIT FALSE, so do not assume it can grant EXECUTE after transfer.
-- Capture exact prior effective role before switching; this example begins explicitly as ai_hr_owner.
SET LOCAL ROLE ai_hr_draft_discard_port;
GRANT EXECUTE ON FUNCTION app.native_employee_draft_discard_delete(uuid) TO ai_hr_app;
SET LOCAL ROLE ai_hr_owner;
-- If the actual prior role was different or 'none', restore that exact prior state instead.
-- Keep transaction open until all catalog/ACL assertions and owner restoration succeed.
```

Future source assembly must use either an explicitly documented operator/migration sequence with exact prior-role restoration, or an invoker installation DO block that captures current_setting('role') and restores it using set_config after its temporary switch. No SECURITY DEFINER installation wrapper, no leaked child effective role to later migration statements, and no assumption postgres privileges exist in deployment. PUBLIC execute is revoked before any exposure; all installation statements are transactional. Role provisioning itself remains a separate reviewed operator dependency.

## 6. Completion and cleanup obligations outside this port prototype

Before any completion UPDATE, the closed completion owner must read the pending review FOR UPDATE and check its actual tuple xmin against pg_current_xact_id()::xid, nonnull exact source/deleted digest and recorded XID, actual native event actor/tenant/draft/payload/xmin, continued absence, and the independent counter proof. A child-savepoint stamp has child xmin even when recorded pg_current_xact_id() is the parent: checking only the recorded XID is insufficient. Do not wash witness xmin by first performing an owner UPDATE, expiry adjustment or event attachment. Raw activation deletion, old/foreign native events and forged parent-level events cannot adopt the stamp.

Generic actual-DELETE deferred cleanup is independent: canonical Access held, indexed deterministic bounded NOWAIT batches until none, no SKIP/total cap; preserve both current USER pending activation/discard bodies through their own native completion, then retire every remaining pending review and body. No CPU/deadline guarantee. Any cleanup/lock failure escapes and rolls back the whole native mutation. Privacy/FK/owner maintenance exceptions and early SET CONSTRAINTS behavior require their own hosted interleavings.

## 7. Required catalog and behavior review

- Actual app LOGIN tests, plus actual NOSUPERUSER NOCREATEROLE migration-owner rehearsal; postgres-only setup can mask role provisioning or storage-owner exceptions.
- Function owner, prosecdef, fixed proconfig/search_path/row_security; table owners differ; row_security_active checked inside actual port execution; native TO-app policies apply by inheritance.
- Full role graph and PG16 options: app cannot inherit/SET port or reach platform/owner; port inherits app only; schema CREATE removed; migration owner restoration exact.
- Column ACLs/RLS: no app raw ledger or content grants; port can update only new witness fields and cannot read ciphertext; no new native draft policy; no role-based admin fallback.
- Same native GUI/outerTx deletion semantics, nullable USER/PERSON distinctions, author/company/deny/foreign/current-principal boundaries; source mismatch/schema drift skips encoding and stamping; actual RETURNING materialization and cheap source bounding remain explicit memory-review gaps, not guaranteed large-GUI behavior.
- Correct actual OLD fourteen-part proof; missing/mismatched/old/foreign/overwrite attempts; raw activation no stamp; released-child-savepoint deletion plus parent event cannot complete.
- Completed receipt/body/expiry/erasure compatibility and no pending ciphertext after actual committed deletion. Preserve original0714 API/grants/body requirements.

Open source-review items are the SQL-owned same-snapshot prepare context/cheap memory bound, actual RETURNING materialization behavior, exact P0002 wrapper mapping, acceptance of capture-only schema/version handling and tagged UTC hash encoding, restricted-role provisioning/install-role restoration plan, completed-receipt owner erasure clearing integration, and independent event/counter/cleanup proof. These are explicit review gaps, not claims of approval. No SQL from this document is ready to execute or allocated to a migration.

## Additional source-review items before execution

The fenced RLS prototype rechecks clock_timestamp expiry in UPDATE WITH CHECK. Review the expiry-boundary behavior before assembly: capture is optional for an ordinary native GUI discard, so an elapsed review deadline must not turn an otherwise authorized native deletion into a new failure merely because it crosses during stamping. The final completion owner must still enforce the actual deadline. The child role cannot change expires_at; use that immutability and the old-row eligibility check rather than treating this unfinished predicate as approved.

An additive clearing candidate is a private new-kind-only AFTER INSERT hook on the existing protected assistant_review_erasure_intent. It could clear source/witness fields for the intent's admitted review_ids even when a completed review body was already removed. This is under independent review, not implemented: prove the existing canonical erasure admission and deferred actual-audit obligations, and allow the invoker guard's owner-only clearing branch only when that protected intent covers the row. Do not infer completed erasure from a body DELETE alone or grant the port role access to privacy intents.


## Independently checked privacy-hook integration conditions

Read-only review of the current0622 owner confirms that its redaction captures associated review IDs, including completed rows whose bodies are already gone; it retains actor/person/company bindings, removes bodies and private digests, then inserts the protected assistant_review_erasure_intent. An additive private AFTER INSERT hook on that intent is therefore a viable integration point. No hook is implemented here.

- The hook must preserve generic cleanup that happens before the intent is inserted. A pending row may already be refused and its witness retired at that point.
- A completed row must be allowed to clear its entire private source/witness tuple irreversibly. The guard and final CHECKs must allow the erased completed shape; recovery then becomes unavailable.
- The hook cannot require event_id immediately: the canonical owner binds the actual erasure audit later, and existing deferred obligations must remain unchanged so missing audit rolls the whole transaction back.
- Match the admitted review IDs and erased actor PERSON, not the erasing operator's own PERSON. Do not newly require a top-level tuple xmin for the privacy intent: canonical erasure may legitimately use a child savepoint. This differs from new discard completion's deliberate top-level deletion requirement.
- If the invoker guard consults the protected intent for completed clearing, procedurally require the actual ledger-owner role before that SELECT. The child-port stamp branch must exit first, so no privacy-intent privilege is granted to app or the port role.
- Proof-only clearing can occur when the canonical erased-body count is zero. Preserve that count; do not fake a deleted body or redefine the native audit result.

All built-in calls in the fenced runtime examples are explicitly pg_catalog-qualified to avoid introducing overload lookup through a writable public schema. The final role/schema catalog review must still consider PUBLIC and inherited CREATE privileges, and the real native helper environment; a search_path declaration alone is not a privilege attestation.
