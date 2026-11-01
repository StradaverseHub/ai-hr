-- Reuse the native ancestry query plan. Every argument and company row is still read live.
-- Preserve the entire reviewed SQL expression, owner, ACL, search path and volatility.
DO $company_hierarchy_plan$
DECLARE
 f_oid oid := 'app.is_company_descendant(uuid,uuid)'::regprocedure;
 f_definition text;
 f_body text;
 f_attributes jsonb;
 f_new_body text;
 f_language oid;
BEGIN
 SELECT pg_get_functiondef(p.oid),p.prosrc,to_jsonb(p)-'prosrc'
 INTO f_definition,f_body,f_attributes FROM pg_proc p WHERE p.oid=f_oid;
 IF encode(sha256(convert_to(f_body,'UTF8')),'hex') IS DISTINCT FROM
    '2966296c5a5c1f383e92fc88816b5dfc07c3794d78877b17d0db1d0d1668a670'
    OR (SELECT lanname FROM pg_language WHERE oid=(f_attributes->>'prolang')::oid) IS DISTINCT FROM 'sql'
    OR length(f_definition)-length(replace(f_definition,'LANGUAGE sql',''))<>length('LANGUAGE sql') THEN
  RAISE EXCEPTION 'Unexpected native company ancestry owner; reviewed SQL predecessor required';
 END IF;
 SELECT oid INTO STRICT f_language FROM pg_language WHERE lanname='plpgsql';
 f_new_body:=E'BEGIN\n RETURN (\n'||regexp_replace(f_body,';[[:space:]]*$','')||E'\n );\nEND;';
 EXECUTE replace(replace(f_definition,f_body,f_new_body),'LANGUAGE sql','LANGUAGE plpgsql');
 IF (SELECT to_jsonb(p)-'prosrc'-'prolang' FROM pg_proc p WHERE oid=f_oid) IS DISTINCT FROM f_attributes-'prolang'
    OR (SELECT prolang FROM pg_proc WHERE oid=f_oid) IS DISTINCT FROM f_language
    OR (SELECT prosrc FROM pg_proc WHERE oid=f_oid) IS DISTINCT FROM f_new_body THEN
  RAISE EXCEPTION 'Native company ancestry attributes or expression changed unexpectedly';
 END IF;
END;
$company_hierarchy_plan$;
