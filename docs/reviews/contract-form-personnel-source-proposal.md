# Personnel values in shared Forms

Status: proposed and unapplied. Automatic approval review rejected the new Personnel/statutory read adapter. No proposed country reader, migration or grant has been installed or registered.

The requested approval is to fill a shared Form with **only Personnel fields referenced by its published template**, for the actual employee in that Contract case. Only verified people assigned to the document’s current or previous routing steps may see Form contents. Case-view permission alone does not reveal these values, including after release. This does not update Personnel or Payroll.

The finite country-owned fields are those already used by the existing V9 Personnel adapter: IC number, passport number, bank name/account, EPF number and tax number. A template referencing none of these reads none. Unknown fields or company-country setup hold the document with an actionable message.

The proposed adapter is a private, fixed country-pack read function and static country dispatcher. It has no writable function registry, dynamic SQL, administrator impersonation, new owner connection or privilege elevation. Both functions use SECURITY INVOKER and deny direct application execution. The authenticated native document owner derives the real company country, employee person and field list from the stored document before invoking them. Public callers supply only a document ID and cannot choose another person, country or field list.

Before completion, hosted checks must prove actual current/prior UID-and-person routing visibility, no released-case-view shortcut, selected-field-only output, foreign-subject and account-relink refusal, country-pack/static-bridge parity, direct-call refusal, missing-country holds, literal restricted-owner migration and unchanged Personnel/Payroll data.

The following exact private adapter is an **unapplied review proposal**, not an executable migration:

```sql
CREATE FUNCTION app.document_merge_values_my(p_person uuid,p_keys text[])
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF p_keys IS NULL OR cardinality(p_keys)>6
 OR NOT p_keys <@ ARRAY['icNo','passportNo','bankName','bankAcc','epfNo','taxNo']::text[]
 THEN RAISE EXCEPTION 'Unsupported document Personnel source key'
 USING ERRCODE='22023';END IF;
 SELECT coalesce(jsonb_object_agg(source.key,coalesce(source.value,'')),'{}'::jsonb)
 INTO result
 FROM public.employee_statutory_my statutory
 CROSS JOIN LATERAL(VALUES
  ('icNo',statutory.ic_number),('passportNo',statutory.passport_number),
  ('bankName',statutory.bank_name),('bankAcc',statutory.bank_account_no),
  ('epfNo',statutory.epf_number),('taxNo',statutory.tax_number)
 ) source(key,value)
 WHERE statutory.tenant_id=app.current_tenant_id()
 AND statutory.person_id=p_person AND source.key=ANY(p_keys);
 RETURN result;
END $$;
ALTER FUNCTION app.document_merge_values_my(uuid,text[]) OWNER TO ai_hr_owner;
REVOKE ALL ON FUNCTION app.document_merge_values_my(uuid,text[])
FROM PUBLIC,ai_hr_app;

CREATE FUNCTION app.document_country_merge_values(
 p_country text,p_person uuid,p_keys text[]
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.current_tenant_id() IS NULL OR NOT EXISTS(
  SELECT 1 FROM public.person
  WHERE tenant_id=app.current_tenant_id() AND id=p_person
 ) THEN RAISE EXCEPTION 'Document Personnel source unavailable'
 USING ERRCODE='42501';END IF;
 CASE p_country
 WHEN 'MY' THEN RETURN app.document_merge_values_my(p_person,p_keys);
 ELSE RAISE EXCEPTION
  'Set up the company country document reader before using this Personnel field'
  USING ERRCODE='22023';
 END CASE;
END $$;
ALTER FUNCTION app.document_country_merge_values(text,uuid,text[])
OWNER TO ai_hr_owner;
REVOKE ALL ON FUNCTION app.document_country_merge_values(text,uuid,text[])
FROM PUBLIC,ai_hr_app;
```

Approval of this read behavior does not approve merging, staging installation or release. Until it is approved and verified, unsupported Personnel-locked fields remain held and will not be represented as complete.
