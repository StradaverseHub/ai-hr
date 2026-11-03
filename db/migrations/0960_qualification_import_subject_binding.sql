-- Authenticate the server packet first, then independently admit its exact subjects in storage.
CREATE FUNCTION app.qualification_import_preview_subject_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF jsonb_typeof(NEW.packet->'subjects') IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'Qualification import subjects unavailable' USING ERRCODE='42501';
 END IF;
 IF jsonb_array_length(NEW.packet->'subjects')<>jsonb_array_length(NEW.packet->'records')
  OR EXISTS (
   SELECT FROM jsonb_to_recordset(NEW.packet->'subjects') AS subject(
    "employmentId" uuid,"companyId" uuid,"employeeCode" text,"recordId" uuid)
   LEFT JOIN public.employment e ON e.id=subject."employmentId" AND e.tenant_id=NEW.tenant_id
   LEFT JOIN public.company c ON c.id=e.company_id AND c.tenant_id=e.tenant_id
   WHERE e.id IS NULL OR c.id IS NULL OR c.archived_at IS NOT NULL
    OR e.company_id IS DISTINCT FROM subject."companyId"
    OR upper(btrim(e.employee_code)) IS DISTINCT FROM subject."employeeCode"
    OR e.voided_at IS NOT NULL OR e.blacklisted_at IS NOT NULL
    OR least(e.resignation_date,e.last_working_date,e.terminated_on)<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
    OR app.is_admin_for(e.company_id) IS NOT TRUE
    OR app.workforce_section_import_allowed(e.company_id,'view') IS NOT TRUE
    OR app.workforce_section_import_allowed(e.company_id,'execute') IS NOT TRUE
    OR app.access_workforce_employment(e.id,'workforce.view') IS NOT TRUE
    OR app.access_workforce_employment(e.id,'workforce.edit') IS NOT TRUE
    OR subject."recordId" IS NOT NULL AND NOT EXISTS(
     SELECT FROM public.employee_qualification q
     WHERE q.id=subject."recordId" AND q.tenant_id=e.tenant_id AND q.employment_id=e.id
      AND q.archived_at IS NULL)
  ) THEN
  RAISE EXCEPTION 'Qualification import subjects unavailable' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.qualification_import_preview_subject_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER qualification_import_preview_subject_guard BEFORE INSERT ON app.qualification_import_preview
 FOR EACH ROW EXECUTE FUNCTION app.qualification_import_preview_subject_guard();
