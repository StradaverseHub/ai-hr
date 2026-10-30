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


## Saved draft DELETE cleanup — NONEXECUTABLE SQL proposal

**Review text only. Do not execute, copy into a migration or mount.** No migration filename/index/timestamp, role/grant expansion, source-proof implementation or production authority is claimed. This proposal adds no repository changes. It describes only deferred retirement of existing draft-review ciphertexts after an actual native DELETE; it does not prove discard completion, stamp a witness or erase all PII/history/backups.

Verified source baseline: `835b2d68e8924638d61902c35229e9ef88e123e5`. Relevant existing owners: `0579_configurable_access.sql` (`app.access_workforce_storage_owner`, `app.access_workforce_write_lock`, native draft statement/row triggers), `0622_own_leave_review_store.sql` (private ledger/content tables and protected identity owner), and `0714_assistant_employee_draft_activation.sql` (current activation completion requires pending body and removes its completed body). The new discard kind and its future private source/witness terminal guard are dependencies, not implemented by this prototype.

### Proposed trigger and ordered partial index

The generic trigger stamps **nothing**. It is bound to exact `public.employee_draft`, fires only after a real DELETE and defers ALL cleanup until COMMIT. There is no immediate retirement of another user's rows, no app-executable marker writer and no Lifecycle key/query copied here. The future discard port alone may produce a discard-specific stamp under its independently reviewed proof design; an activation DELETE must never mint discard proof.

Normal application native DELETE already acquires canonical Access through its existing BEFORE statement trigger. At deferred cleanup, check the existing real storage-owner predicate FIRST: a trusted maintenance caller always uses **try** acquisition of the exact existing OLD-tenant Access key, even when OLD tenant equals the current tenant. Maintenance may already hold physical rows while an app caller owns Access and waits on those rows; routing same-tenant owner maintenance through the blocking ordinary helper could form a cycle. Only the non-storage-owner application branch requires OLD tenant=current tenant and calls the existing reentrant Access owner. The storage-owner predicate binds both `session_user` and selected role; never trust `current_user` inside a SECURITY DEFINER function. Do not change tenant/USER/role GUCs. This maintenance branch is serialization only, not a new application admission course. Built-in try-lock, hash and clock calls in the private prototype are explicitly `pg_catalog` qualified.

```sql
-- NONEXECUTABLE REVIEW PROTOTYPE. Required new-kind/terminal-guard dependencies are not installed.
-- Same existing canonical Access key; no new coordination key is introduced.
CREATE INDEX assistant_review_pending_draft_cleanup
 ON app.assistant_own_leave_review(tenant_id,receipt_subject_id,id)
 WHERE receipt_subject_kind='employee_draft'
   AND action_kind IN ('employees.draft.activate','employees.draft.discard')
   AND state='awaiting_confirmation';

CREATE FUNCTION app._assistant_employee_draft_delete_cleanup() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE candidate record; changed integer; owned boolean;
BEGIN
 IF TG_OP IS DISTINCT FROM 'DELETE'
    OR TG_RELID IS DISTINCT FROM 'public.employee_draft'::regclass THEN
  RAISE EXCEPTION 'Draft review cleanup unavailable' USING ERRCODE='42501';
 END IF;
 IF OLD.tenant_id IS NULL OR OLD.id IS NULL THEN
  RAISE EXCEPTION 'Draft review cleanup unavailable' USING ERRCODE='42501';
 END IF;

 -- Storage-owner maintenance always tries FIRST, including same-tenant maintenance.
 -- It may already hold physical rows while another app caller owns Access and waits on
 -- those rows; routing it through the blocking ordinary helper could create a cycle.
 IF app.access_workforce_storage_owner() IS TRUE THEN
  SELECT pg_catalog.pg_try_advisory_xact_lock(
   pg_catalog.hashtextextended('access-configuration:'||OLD.tenant_id::text,0)
  ) INTO owned;
  IF owned IS NOT TRUE THEN
   RAISE EXCEPTION 'Draft review cleanup busy' USING ERRCODE='55P03';
  END IF;
  -- No application principal/policy decision, GUC retargeting or current_user authority.
 ELSE
  IF OLD.tenant_id IS DISTINCT FROM app.current_tenant_id() THEN
   RAISE EXCEPTION 'Draft review cleanup unavailable' USING ERRCODE='42501';
  END IF;
  -- Ordinary app DELETE already owns this barrier through its BEFORE statement trigger.
  PERFORM app.access_workforce_write_lock();
 END IF;

 -- PL/pgSQL uses an internal cursor for this FOR query; fetch bounded batches rather
 -- than collecting every ID/body in one array. No LIMIT, SKIP LOCKED or global-N cap.
 -- The additive partial index supports this tenant/subject/id order. Verify the actual
 -- hosted plan; the planner is not forced to choose an index by this SQL text.
 FOR candidate IN
  SELECT r.id
  FROM app.assistant_own_leave_review r
  WHERE r.tenant_id=OLD.tenant_id
    AND r.receipt_subject_kind='employee_draft'
    AND r.receipt_subject_id=OLD.id
    AND r.action_kind IN ('employees.draft.activate','employees.draft.discard')
    AND r.state='awaiting_confirmation'
  ORDER BY r.id
  FOR UPDATE OF r NOWAIT
 LOOP
  -- A raw owner may hold only the content row, then wait for canonical Access. Lock it
  -- NOWAIT before any state change/body DELETE to avoid waiting through that cycle.
  -- Read no ciphertext; a missing body is valid row-only retirement, not an error.
  PERFORM 1 FROM app.assistant_own_leave_review_content c
   WHERE c.action_id=candidate.id FOR UPDATE OF c NOWAIT;

  -- REQUIRED dependency: the future schema-owner terminal guard for the new discard
  -- kind must recognize this exact actual-DELETE cleanup course and clear ALL its
  -- private source/witness columns on retirement. Do not invent those columns here.
  -- Existing activation's constraints/columns remain unchanged. No witness is stamped.
  UPDATE app.assistant_own_leave_review r
   SET state=CASE WHEN pg_catalog.clock_timestamp()>=r.expires_at THEN 'expired' ELSE 'discarded' END,
       intent_digest=NULL,reviewed_digest=NULL
   WHERE r.id=candidate.id AND r.tenant_id=OLD.tenant_id
     AND r.receipt_subject_kind='employee_draft' AND r.receipt_subject_id=OLD.id
     AND r.action_kind IN ('employees.draft.activate','employees.draft.discard')
     AND r.state='awaiting_confirmation';
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed<>1 THEN
   RAISE EXCEPTION 'Draft review cleanup changed' USING ERRCODE='40001';
  END IF;
  DELETE FROM app.assistant_own_leave_review_content c WHERE c.action_id=candidate.id;
  IF EXISTS(SELECT 1 FROM app.assistant_own_leave_review_content c WHERE c.action_id=candidate.id) THEN
   RAISE EXCEPTION 'Draft review body retirement incomplete' USING ERRCODE='42501';
  END IF;
 END LOOP;

 -- Closed prepare owners take the SAME canonical Access barrier and require the real
 -- draft, so they cannot insert a new pending row after this scan but before commit.
 -- No matching pending row also means no body belonging to such a pending row remains.
 -- Already-terminal legacy body orphans are outside this pending-retirement course;
 -- they are neither silently repaired nor a new reason to refuse ordinary native DELETE.
 IF EXISTS(
  SELECT 1 FROM app.assistant_own_leave_review r
  WHERE r.tenant_id=OLD.tenant_id
    AND r.receipt_subject_kind='employee_draft' AND r.receipt_subject_id=OLD.id
    AND r.action_kind IN ('employees.draft.activate','employees.draft.discard')
    AND r.state='awaiting_confirmation'
 ) THEN
  RAISE EXCEPTION 'Draft review cleanup incomplete' USING ERRCODE='42501';
 END IF;
 RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION app._assistant_employee_draft_delete_cleanup() FROM PUBLIC,ai_hr_app;

CREATE CONSTRAINT TRIGGER assistant_employee_draft_delete_cleanup
 AFTER DELETE ON public.employee_draft
 DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION app._assistant_employee_draft_delete_cleanup();
```

No public EXECUTE grant, raw ledger/content grant, trigger-attachment grant or ALTER-role template belongs to this change. The private function's SECURITY DEFINER owner must be the actual schema owner at any later migration execution; that remains deployment/migration-owner controlled, not an application input. A fake/temp relation trigger still fails the exact TG_RELID check even in a privileged test; normal app cannot attach this function without EXECUTE. Existing normal DELETE RLS/row-trigger admission remains authoritative.

### Completion, retirement and rollback semantics

All current and other-user pending activation/discard bodies remain until deferred cleanup. This course retires pending custody only; it neither repairs nor claims to remove pre-existing already-terminal legacy body orphans. Per-retired-row body assertions cover only rows actually retired here, and the final assertion covers remaining matching pending custody. A legitimate current activation completes through existing 0714 and deletes its body before COMMIT; a future current discard must do the same only after its independent actual-native proof. This cursor excludes completed rows. Default native GUI discard/activation with neither, either or both same-user kinds still has remaining pending bodies retired at COMMIT; other users' number of reviews is not bounded by that same-user pair.

`SET CONSTRAINTS ... IMMEDIATE` (or ALL IMMEDIATE) can deliberately fire cleanup before native completion. It may retire the pending body; a later activation/discard completion must then refuse, and the caller must roll back the WHOLE transaction. It must never resurrect the row/body, accept completed-by-absence or catch the refusal and commit a claimed Assistant success. A default native DELETE that is not claiming Assistant completion may still commit its truthful deletion and retirement after immediate cleanup.

The future new-kind terminal guard must clear every private source/witness field only along legitimate schema-owner transitions, including this actual DELETE cleanup, existing generic expiry and privacy/erasure retirement. It must prevent application creation/transplant/mutation of witness fields. Activation's existing field/check relationships stay unchanged. This proposal does not invent a function/GUC to bless a transition or settle that guard's implementation.

Install non-increasing `lock_timeout` and `statement_timeout` bounds BEFORE commands and retain them through COMMIT/deferred work; do not restore them before COMMIT. PostgreSQL statement_timeout bounds each SQL command (including the COMMIT command running deferred work), not elapsed duration of the whole multi-command transaction; lock_timeout bounds individual lock waits. Internal statements/cursor batches do not provide a fixed overall business-operation duration promise. With unbounded review fanout, timeout/refusal and whole-transaction rollback are acceptable. There is no fixed GUI progress, memory-to-zero, eventual-success or fixed wall-clock guarantee. Review rows and each existing matching content row use NOWAIT before state mutation/body deletion; missing bodies permit row-only retirement. Failures, cancellation, guard errors or final-assertion failures escape the whole native transaction, leaving no partial cleanup/deletion/counter/event commit.

The ordered partial index avoids requiring a large ID array and supplies the intended scan order. The PL/pgSQL cursor fetches incrementally, but the planner may select another plan/sort; verify representative hosted plans and bounded memory behavior rather than treating the index declaration as a proof. The function has no numeric LIMIT, SKIP LOCKED omission or silent cleanup truncation.

Actual DELETE matters: app baseline `0337_employee_draft.sql` grants SELECT/INSERT/UPDATE/DELETE, not TRUNCATE. Privileged raw-owner TRUNCATE does not fire a DELETE row trigger. Any production owner TRUNCATE/reset/restore requires a separately reviewed operator cleanup protocol; test harness reset must reset all associated state. This proposal does not invent a production TRUNCATE guarantee or claim global PII purge.

### Hosted verification plan after independent source review and allocation

- Actual native default discard and activation with zero pending reviews, activation only, discard only, both current-user kinds and many other USERs; current legitimate completion happens before COMMIT, remaining pending-row count and bodies of rows retired by this trigger are zero afterward, unrelated tenant/draft/kind rows and completed receipts remain unchanged.
- TTL boundaries produce expired versus discarded; per-row digests and future new-kind source/witness fields clear, no body survives for a row retired by this trigger and no matching pending custody remains; old activation constraints remain valid. For every row retired by this trigger, verify body absence immediately after DELETE. A pre-existing matching already-terminal legacy body orphan remains unchanged and is explicitly outside the pending-custody cleanup claim; it must not create permanent ordinary native GUI refusal. Any broader historical-orphan cleanup requires separate coordinator policy review.
- One other USER's review row locked by another transaction; a late review row in the ordered scan locked; a late content-only row locked by a raw owner that subsequently requests canonical Access while the native transaction owns Access; future guard failure, content-delete failure, final-assertion failure, cancellation and COMMIT timeout: ALL draft/counter/event/review/body effects roll back; no skipped body or partially committed native deletion. The content-only lock fixture must prove the prelock raises NOWAIT before that candidate's state UPDATE/DELETE, releases the native transaction's Access on WHOLE-Tx rollback and leaves ALL earlier candidates plus draft/counter/events unchanged; the owner can then acquire Access. Also verify a missing-body candidate retires its row successfully without reading ciphertext. Native success may be retried only through the normal fresh source course after rollback.
- Many-user/fanout fixtures exceed any same-user pending cap. Exercise actual ordered index/cursor plan and memory observations under representative hosted settings without promising fixed completion time. No all-ID arrays, silent N cap or SKIP LOCKED pass.
- Concurrent prepare/expiry/retirement versus native DELETE uses canonical Access serialization: a later prepare cannot retain a body for a deleted draft. Race same tenant/draft and independent tenants; native counter/config edits and Lifecycle work stay with their own existing owners, not copied lock keys.
- Trusted storage-owner same-tenant AND multi-tenant maintenance, no tenant GUC, mismatched current tenant, busy exact OLD-tenant Access key and many deleted OLD tenants: owner predicate is real session/selected-role authority, no GUC changes, busy is WHOLE-Tx failure even when OLD tenant=current tenant. Force a same-tenant owner-row-lock versus app-Access interleaving to prove immediate refusal rather than a blocking-helper cycle. App/definer `current_user` is not owner authority. Fake/temp relation trigger and direct function invocation are refused; no new application grants.
- Force constraints IMMEDIATE before completion and after default native deletion. Premature current Assistant completion refuses and rolls back fully; normal default deletion can still truthfully commit retirement. Rollback-only preview loses every DELETE/deferred event/retirement effect and cannot supply final completion proof.
- The selected B port-only actual-DELETE/native-event/counter proof is a separate, unimplemented dependency; this generic cleanup never stamps either discard or activation. Native audit retains its normal reserved-code metadata. Test owner TRUNCATE only as an explicit out-of-trigger/reset protocol case; do not label it covered by DELETE cleanup.
