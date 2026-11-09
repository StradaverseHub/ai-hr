-- READ-ONLY protocol vector query only. No function/profile/role/install API.
-- $1 is owner-validated JSON data; $2 is API version2/3. This query grants nothing.
WITH source AS MATERIALIZED(SELECT $1::text::jsonb AS document,$2::integer AS api),
items AS MATERIALIZED(
 SELECT value AS j FROM source CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(document)='array' AND octet_length(document::text)<=16777216 THEN document ELSE '[]'::jsonb END)
),checked AS MATERIALIZED(
 SELECT j,coalesce(
  jsonb_typeof(j)='object'
  AND j?&ARRAY['eventType','kind','category','recipientPort','implemented','audience','guard']
  AND NOT EXISTS(SELECT 1 FROM jsonb_object_keys(CASE WHEN jsonb_typeof(j)='object' THEN j ELSE '{}'::jsonb END)k
   WHERE k NOT IN('eventType','kind','category','recipientPort','implemented','audience','guard'))
  AND jsonb_typeof(j->'eventType')='string' AND octet_length(j->>'eventType') BETWEEN 1 AND 1048576
  AND jsonb_typeof(j->'kind')='string' AND octet_length(j->>'kind') BETWEEN 1 AND 1048576
  AND (j->'category'='null'::jsonb OR jsonb_typeof(j->'category')='string' AND octet_length(j->>'category') BETWEEN 1 AND 1048576)
  AND (j->'recipientPort'='null'::jsonb OR jsonb_typeof(j->'recipientPort')='string' AND octet_length(j->>'recipientPort') BETWEEN 1 AND 1048576)
  AND jsonb_typeof(j->'implemented')='boolean' AND jsonb_typeof(j->'audience')='string' AND j->>'audience' IN('subject','reader','none')
  AND CASE WHEN j->>'audience'='reader' THEN j->'recipientPort'<>'null'::jsonb ELSE j->'recipientPort'='null'::jsonb END
  AND (j->'guard'='null'::jsonb OR jsonb_typeof(j->'guard')='object'
   AND (j->'guard')?&ARRAY['field','equals']
   AND NOT EXISTS(SELECT 1 FROM jsonb_object_keys(CASE WHEN jsonb_typeof(j->'guard')='object' THEN j->'guard' ELSE '{}'::jsonb END)k WHERE k NOT IN('field','equals','not'))
   AND jsonb_typeof(j->'guard'->'field')='string' AND j->'guard'->>'field' IN('overtime','supersededByAdminCancellation','notify')
   AND j->'guard'->'equals'='true'::jsonb AND (NOT((j->'guard')?'not') OR j->'guard'->'not'='true'::jsonb))
 ,false)AS valid FROM items
),encoded AS MATERIALIZED(
 SELECT j,valid,decode('52','hex')
  ||decode('54','hex')||int4send(octet_length(convert_to(j->>'eventType','UTF8')))||convert_to(j->>'eventType','UTF8')
  ||decode('54','hex')||int4send(octet_length(convert_to(j->>'kind','UTF8')))||convert_to(j->>'kind','UTF8')
  ||CASE WHEN j->'category'='null'::jsonb THEN decode('4e','hex') ELSE decode('54','hex')||int4send(octet_length(convert_to(j->>'category','UTF8')))||convert_to(j->>'category','UTF8')END
  ||CASE WHEN j->'recipientPort'='null'::jsonb THEN decode('4e','hex') ELSE decode('54','hex')||int4send(octet_length(convert_to(j->>'recipientPort','UTF8')))||convert_to(j->>'recipientPort','UTF8')END
  ||CASE WHEN j->'implemented'='true'::jsonb THEN decode('59','hex')ELSE decode('46','hex')END
  ||decode('54','hex')||int4send(octet_length(convert_to(j->>'audience','UTF8')))||convert_to(j->>'audience','UTF8')
  ||CASE WHEN j->'guard'='null'::jsonb THEN decode('4e','hex')ELSE decode('47','hex')
   ||decode('54','hex')||int4send(octet_length(convert_to(j->'guard'->>'field','UTF8')))||convert_to(j->'guard'->>'field','UTF8')||decode('59','hex')
   ||CASE WHEN(j->'guard')?'not' THEN decode('5059','hex')ELSE decode('41','hex')END END AS bytes
 FROM checked
),summary AS MATERIALIZED(
 SELECT count(*)::integer AS n,coalesce(bool_and(valid),false)AS all_valid,
  count(DISTINCT ROW((j->>'eventType')COLLATE "C",(j->>'kind')COLLATE "C"))::integer AS distinct_ids,
  coalesce(sum(octet_length(bytes)),0)AS payload_bytes FROM encoded
),admitted AS MATERIALIZED(
 SELECT s.api,c.n,(jsonb_typeof(s.document)='array' AND octet_length(s.document::text)<=16777216 AND s.api IN(2,3)
  AND c.n BETWEEN 1 AND 10000 AND c.all_valid AND c.distinct_ids=c.n AND c.payload_bytes+42<=1048576)IS TRUE AS valid
 FROM source s CROSS JOIN summary c
),result AS MATERIALIZED(
 SELECT a.n,a.valid,CASE WHEN a.valid THEN
  decode('414948525f4e4f54494649434154494f4e5f5245434950455f5345414c00','hex')||int4send(1)||int4send(a.api)||int4send(a.n)
  ||(SELECT string_agg(e.bytes,''::bytea ORDER BY(e.j->>'eventType')COLLATE "C",(e.j->>'kind')COLLATE "C")FROM encoded e)
  ELSE NULL::bytea END AS bytes FROM admitted a
)
SELECT valid,n AS "recipeCount",encode(bytes,'hex')AS hex,octet_length(bytes)AS "byteLength",encode(sha256(bytes),'hex')AS sha256 FROM result;
