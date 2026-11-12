-- Proof-only fixed SELECT. No installation, source writes or business rows.
WITH scalars AS MATERIALIZED(
 SELECT cp,chr(cp)AS original FROM generate_series(1,1114111)cp WHERE cp NOT BETWEEN 55296 AND 57343
),transformed AS MATERIALIZED(
 SELECT cp,/* EXACT_ASCII_OBSERVATION_TRANSFORM */ AS value FROM scalars
),observed AS MATERIALIZED(
 SELECT cp,convert_to(regexp_replace(value COLLATE "C",'[^'||chr(1)||'-'||chr(127)||']+',U&'\E000','g'),'UTF8')AS bytes FROM transformed
),framed AS MATERIALIZED(
 SELECT cp,int4send(cp)||int4send(octet_length(bytes))||bytes AS bytes FROM observed
)
SELECT count(*)::integer AS count,min(cp)::integer AS first,max(cp)::integer AS last,
 string_agg(bytes,''::bytea ORDER BY cp)AS bytes FROM framed;
