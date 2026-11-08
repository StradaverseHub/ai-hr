-- Fixed built-in-only vector query; $1 is bounded fictional JSON data, not SQL.
WITH items AS MATERIALIZED(
 SELECT (value->>'id')::integer AS id,value->>'text' AS original,value->>'q' AS q FROM jsonb_array_elements($1::text::jsonb)
),transformed AS MATERIALIZED(
 SELECT id,original,q,/* EXACT_ASCII_OBSERVATION_TRANSFORM */ AS value,
  translate(replace(original,U&'\0130','i'),'ABCDEFGHIJKLMNOPQRSTUVWXYZ'||U&'\212A','abcdefghijklmnopqrstuvwxyzk')AS without_dot,
  translate(replace(original,U&'\0130',U&'i\0307'),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')AS without_kelvin
 FROM items
),admitted AS MATERIALIZED(
 SELECT *,q IS NOT NULL AND char_length(q)>0 AND octet_length(convert_to(q,'UTF8'))=char_length(q)
  AND q=translate(q,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')AS valid FROM transformed
)
SELECT id,valid,regexp_replace(value COLLATE "C",'[^'||chr(1)||'-'||chr(127)||']+',U&'\E000','g')AS observation,
 CASE WHEN valid THEN position(convert_to(q,'UTF8')in convert_to(value,'UTF8'))>0 END AS matched,
 CASE WHEN valid THEN position(convert_to(q,'UTF8')in convert_to(without_dot,'UTF8'))>0 END AS "withoutDot",
 CASE WHEN valid THEN position(convert_to(q,'UTF8')in convert_to(without_kelvin,'UTF8'))>0 END AS "withoutKelvin"
FROM admitted ORDER BY id;
