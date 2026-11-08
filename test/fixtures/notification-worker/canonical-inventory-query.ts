/** Fixed set-wise catalog SELECT only. Each referenced raw catalogue row is
 * emitted once in its OID-keyed dictionary, in the SAME native snapshot. */
const oidArray=(expression:string)=>`(select coalesce(jsonb_agg(v.type_oid::bigint order by v.ordinality),'[]'::jsonb) from unnest(${expression})with ordinality v(type_oid,ordinality))`;
export const notificationCanonicalInventoryQuery=`
with canonical as materialized(select p.* from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='app'),
type_oids as materialized(
 select prorettype as oid from canonical union select unnest(proargtypes::oid[])from canonical
 union select unnest(proallargtypes)from canonical union select unnest(protrftypes)from canonical
 union select provariadic from canonical where provariadic<>0
),
types as materialized(select t.oid,t.typnamespace,jsonb_build_object('oid',t.oid::bigint,'namespaceOid',n.oid::bigint,'schema',n.nspname,'name',t.typname,
 'identity',format('%I.%I',n.nspname,t.typname),'formatted',format_type(t.oid,null),'raw',to_jsonb(t))as value
 from type_oids wanted join pg_catalog.pg_type t on t.oid=wanted.oid join pg_catalog.pg_namespace n on n.oid=t.typnamespace),
namespace_oids as materialized(select pronamespace as oid from canonical union select typnamespace from types),
namespaces as materialized(select n.oid,jsonb_build_object('oid',n.oid::bigint,'name',n.nspname,'raw',to_jsonb(n))as value
 from namespace_oids wanted join pg_catalog.pg_namespace n on n.oid=wanted.oid),
languages as materialized(select l.oid,jsonb_build_object('oid',l.oid::bigint,'name',l.lanname,'raw',to_jsonb(l))as value
 from pg_catalog.pg_language l where l.oid in(select prolang from canonical)),
function_acls as materialized(select p.oid,a.grantor,a.grantee,a.privilege_type,a.is_grantable
 from canonical p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a),
acl_rows as materialized(select a.oid,jsonb_agg(jsonb_build_object('grantorOid',a.grantor::bigint,'granteeOid',a.grantee::bigint,'privilege',a.privilege_type,'grantable',a.is_grantable)
 order by a.grantor,a.grantee,a.privilege_type collate "C",a.is_grantable)as value from function_acls a group by a.oid),
role_oids as materialized(select proowner as oid from canonical union select grantor from function_acls union select grantee from function_acls),
roles as materialized(select wanted.oid,jsonb_build_object('oid',wanted.oid::bigint,'name',case when wanted.oid=0 then 'PUBLIC'else r.rolname end)as value
 from role_oids wanted left join pg_catalog.pg_roles r on r.oid=wanted.oid),
supports as materialized(select p.oid,jsonb_build_object('oid',p.oid::bigint,'identity',p.oid::regprocedure::text,'raw',to_jsonb(p))as value
 from pg_catalog.pg_proc p where p.oid in(select prosupport::oid from canonical where prosupport::oid<>0)),
functions as materialized(select p.oid,p.oid::regprocedure::text as signature,jsonb_build_object(
 'raw',to_jsonb(p),'signature',p.oid::regprocedure::text,
 'namespaceOid',p.pronamespace::bigint,'ownerOid',p.proowner::bigint,'languageOid',p.prolang::bigint,'returnTypeOid',p.prorettype::bigint,
 'inputTypeOids',${oidArray('p.proargtypes::oid[]')},
 'allTypeOids',case when p.proallargtypes is null then null else ${oidArray('p.proallargtypes')}end,
 'transformTypeOids',case when p.protrftypes is null then null else ${oidArray('p.protrftypes')}end,
 'variadicTypeOid',p.provariadic::bigint,'supportOid',p.prosupport::oid::bigint,'supportText',p.prosupport::text,
 'acl',coalesce(a.value,'[]'::jsonb),
 'nativeArguments',pg_get_function_arguments(p.oid),'nativeIdentityArguments',pg_get_function_identity_arguments(p.oid),'nativeResult',pg_get_function_result(p.oid),
 'nativeDefaults',case when p.proargdefaults is null then null else pg_get_expr(p.proargdefaults,0,false)end,
 'nativeDefinition',case when p.prokind in('f','p','w')then pg_get_functiondef(p.oid)else null end,
 'sourceBytes',octet_length(p.prosrc),'sourceSha256',encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')
 )as value from canonical p left join acl_rows a on a.oid=p.oid),
dependencies as materialized(select d.*,jsonb_build_object('raw',to_jsonb(d),'classIdentity',d.classid::regclass::text,'referenceClassIdentity',d.refclassid::regclass::text,
 'object',to_jsonb(pg_identify_object(d.classid,d.objid,d.objsubid)),'reference',to_jsonb(pg_identify_object(d.refclassid,d.refobjid,d.refobjsubid)))as value
 from pg_catalog.pg_depend d where d.classid='pg_proc'::regclass and d.objid in(select oid from canonical)or d.refclassid='pg_proc'::regclass and d.refobjid in(select oid from canonical)),
shared as materialized(select d.*,jsonb_build_object('raw',to_jsonb(d),'classIdentity',d.classid::regclass::text,'referenceClassIdentity',d.refclassid::regclass::text,
 'object',to_jsonb(pg_identify_object(d.classid,d.objid,d.objsubid)),
 'referenceRole',case when d.refclassid='pg_authid'::regclass then(select jsonb_build_object('oid',r.oid::bigint,'name',r.rolname)from pg_catalog.pg_roles r where r.oid=d.refobjid)else null end)as value
 from pg_catalog.pg_shdepend d where d.dbid=(select oid from pg_catalog.pg_database where datname=current_database())and d.classid='pg_proc'::regclass and d.objid in(select oid from canonical))
select jsonb_build_object(
 'formatVersion',2,
 'columns',(select jsonb_agg(a.attname order by a.attnum)from pg_catalog.pg_attribute a where a.attrelid='pg_proc'::regclass and a.attnum>0 and not a.attisdropped),
 'functionCount',(select count(*)::int from canonical),
 'referenceCounts',jsonb_build_object('types',(select count(*)::int from types),'namespaces',(select count(*)::int from namespaces),'languages',(select count(*)::int from languages),'roles',(select count(*)::int from roles),'supports',(select count(*)::int from supports)),
 'dictionaries',jsonb_build_object(
  'types',(select coalesce(jsonb_object_agg(oid::text,value),'{}'::jsonb)from types),
  'namespaces',(select coalesce(jsonb_object_agg(oid::text,value),'{}'::jsonb)from namespaces),
  'languages',(select coalesce(jsonb_object_agg(oid::text,value),'{}'::jsonb)from languages),
  'roles',(select coalesce(jsonb_object_agg(oid::text,value),'{}'::jsonb)from roles),
  'supports',(select coalesce(jsonb_object_agg(oid::text,value),'{}'::jsonb)from supports)),
 'functions',(select coalesce(jsonb_agg(value order by signature collate "C"),'[]'::jsonb)from functions),
 'dependencies',(select coalesce(jsonb_agg(value order by classid,objid,objsubid,refclassid,refobjid,refobjsubid,deptype),'[]'::jsonb)from dependencies),
 'sharedDependencies',(select coalesce(jsonb_agg(value order by dbid,classid,objid,objsubid,refclassid,refobjid,deptype),'[]'::jsonb)from shared)
)as inventory`;
