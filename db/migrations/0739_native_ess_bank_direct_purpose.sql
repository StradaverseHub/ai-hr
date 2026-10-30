-- Development-only native ESS bank admission. Existing 0683 intent, exact-delta, immutable identity,
-- actual audit and deferred completion owners remain authoritative; no shared-person ACL changes.
CREATE FUNCTION app.profile_direct_bank_person(p_person uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(app.profile_direct_person(p_person) AND EXISTS(
  SELECT 1 FROM app.profile_direct_intent i
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(i.proposal->'fields')='array'
   THEN i.proposal->'fields' ELSE '[]'::jsonb END) declared(field)
  JOIN app.access_profile_value_bindings() b ON b.field_id=declared.field->>'fieldId'
  JOIN (VALUES
   ('bank_statutory.bank_information.bankname','bank_name'),
   ('bank_statutory.bank_information.bankaccountno','bank_account_no'),
   ('bank_statutory.bank_information.enablecustomholdername','enable_custom_holder_name'),
   ('bank_statutory.bank_information.customholdername','custom_holder_name'),
   ('bank_statutory.bank_information.enablecustomholderid','enable_custom_holder_id'),
   ('bank_statutory.bank_information.customholderid','custom_holder_id')
  ) allowed(field_id,column_name) ON allowed.field_id=b.field_id AND allowed.column_name=b.column_name
  WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=app.current_tenant_id()
   AND i.user_id=app.current_user_id() AND i.person_id=p_person AND i.proposal->'v'='2'::jsonb
   AND jsonb_typeof(declared.field)='object' AND declared.field ? 'value' AND b.owner='bank'
   AND app.access_profile_value_editable(b.field_id) AND NOT app.profile_field_requires_approval(b.field_id)
 ),false);
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.profile_direct_bank_person(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.profile_direct_bank_person(uuid) TO ai_hr_app;
