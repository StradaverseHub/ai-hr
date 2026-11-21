-- Editing returned content does not transfer custody. Only explicit resend releases the owner hold.
CREATE OR REPLACE FUNCTION app.document_signing_round_actions(p_data jsonb) RETURNS SETOF jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 WITH history AS (
  SELECT a,n FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_data->'actions')='array' THEN p_data->'actions' ELSE '[]'::jsonb END) WITH ORDINALITY x(a,n)
 ), boundary AS (
  SELECT coalesce(max(n) FILTER(WHERE a->>'action'='returned'),0) returned,coalesce(max(n) FILTER(WHERE a->>'action'='resent'),0) resent
  FROM history WHERE jsonb_typeof(p_data->'routing')='object' OR a->>'contentRevision'=p_data->>'contentRevision' AND a->>'contentHash'=p_data->>'contentHash'
 )
 SELECT a FROM history CROSS JOIN boundary WHERE
  CASE WHEN jsonb_typeof(p_data->'routing')='object' AND returned>resent THEN n=returned
   ELSE n>resent AND a->>'contentRevision'=p_data->>'contentRevision' AND (a->>'contentHash'=p_data->>'contentHash'
    OR p_data->>'subjectType'='contract' AND p_data->'routing'->'liveMergeReviews'='true'::jsonb AND a->'signature'='null'::jsonb AND a->>'action' IN('reviewed','approved','returned','resent')) END ORDER BY n
$$;
