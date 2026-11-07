/** Fixed catalog SELECT only. No HR reads, grants, migration or worker API. */
const typeReference=(expression:string)=>`(select jsonb_build_object('oid',t.oid::bigint,'schema',n.nspname,'namespaceOid',n.oid::bigint,'name',t.typname,'identity',format('%I.%I',n.nspname,t.typname),'formatted',format_type(t.oid,null),'raw',to_jsonb(t)) from pg_catalog.pg_type t join pg_catalog.pg_namespace n on n.oid=t.typnamespace where t.oid=${expression})`;
const typeArray=(expression:string)=>`(select coalesce(jsonb_agg(${typeReference('v.type_oid')} order by v.ordinality),'[]'::jsonb) from unnest(${expression}) with ordinality v(type_oid,ordinality))`;
export const notificationCanonicalInventoryQuery=`
with canonical as materialized(select p.* from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='app'),
functions as materialized(select p.oid,p.oid::regprocedure::text as signature,jsonb_build_object(
 'raw',to_jsonb(p),'signature',p.oid::regprocedure::text,
 'namespace',jsonb_build_object('oid',n.oid::bigint,'name',n.nspname,'raw',to_jsonb(n)),
 'owner',jsonb_build_object('oid',r.oid::bigint,'name',r.rolname),
 'language',jsonb_build_object('oid',l.oid::bigint,'name',l.lanname,'raw',to_jsonb(l)),
 'returnType',${typeReference('p.prorettype')},
 'inputTypes',${typeArray('p.proargtypes::oid[]')},
 'allTypes',case when p.proallargtypes is null then null else ${typeArray('p.proallargtypes')} end,
 'transformTypes',case when p.protrftypes is null then null else ${typeArray('p.protrftypes')} end,
 'variadicType',case when p.provariadic=0 then null else ${typeReference('p.provariadic')} end,
 'support',case when p.prosupport::oid=0 then null else(select jsonb_build_object('oid',s.oid::bigint,'identity',s.oid::regprocedure::text,'raw',to_jsonb(s))from pg_catalog.pg_proc s where s.oid=p.prosupport::oid)end,
 'supportOid',p.prosupport::oid::bigint,'supportText',p.prosupport::text,
 'acl',(select coalesce(jsonb_agg(jsonb_build_object('grantorOid',a.grantor::bigint,'grantor',g.rolname,'granteeOid',a.grantee::bigint,'grantee',case when a.grantee=0 then 'PUBLIC'else target.rolname end,'privilege',a.privilege_type,'grantable',a.is_grantable)order by a.grantor,a.grantee,a.privilege_type collate "C",a.is_grantable),'[]'::jsonb)from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a left join pg_catalog.pg_roles g on g.oid=a.grantor left join pg_catalog.pg_roles target on target.oid=a.grantee),
 'nativeArguments',pg_get_function_arguments(p.oid),'nativeIdentityArguments',pg_get_function_identity_arguments(p.oid),
 'nativeResult',pg_get_function_result(p.oid),
 'nativeDefaults',case when p.proargdefaults is null then null else pg_get_expr(p.proargdefaults,0,false)end,
 'nativeDefinition',case when p.prokind in('f','p','w')then pg_get_functiondef(p.oid)else null end,
 'sourceBytes',octet_length(p.prosrc),'sourceSha256',encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')
 )as value from canonical p join pg_catalog.pg_namespace n on n.oid=p.pronamespace join pg_catalog.pg_roles r on r.oid=p.proowner join pg_catalog.pg_language l on l.oid=p.prolang),
dependencies as materialized(select d.*,jsonb_build_object('raw',to_jsonb(d),'classIdentity',d.classid::regclass::text,'referenceClassIdentity',d.refclassid::regclass::text,
 'object',to_jsonb(pg_identify_object(d.classid,d.objid,d.objsubid)),'reference',to_jsonb(pg_identify_object(d.refclassid,d.refobjid,d.refobjsubid)))as value
 from pg_catalog.pg_depend d where d.classid='pg_proc'::regclass and d.objid in(select oid from canonical)or d.refclassid='pg_proc'::regclass and d.refobjid in(select oid from canonical)),
shared as materialized(select d.*,jsonb_build_object('raw',to_jsonb(d),'classIdentity',d.classid::regclass::text,'referenceClassIdentity',d.refclassid::regclass::text,
 'object',to_jsonb(pg_identify_object(d.classid,d.objid,d.objsubid)),
 'referenceRole',case when d.refclassid='pg_authid'::regclass then(select jsonb_build_object('oid',r.oid::bigint,'name',r.rolname)from pg_catalog.pg_roles r where r.oid=d.refobjid)else null end)as value
 from pg_catalog.pg_shdepend d where d.dbid=(select oid from pg_catalog.pg_database where datname=current_database())and d.classid='pg_proc'::regclass and d.objid in(select oid from canonical))
select jsonb_build_object(
 'columns',(select jsonb_agg(a.attname order by a.attnum)from pg_catalog.pg_attribute a where a.attrelid='pg_proc'::regclass and a.attnum>0 and not a.attisdropped),
 'functionCount',(select count(*)::int from canonical),
 'functions',(select coalesce(jsonb_agg(value order by signature collate "C"),'[]'::jsonb)from functions),
 'dependencies',(select coalesce(jsonb_agg(value order by classid,objid,objsubid,refclassid,refobjid,refobjsubid,deptype),'[]'::jsonb)from dependencies),
 'sharedDependencies',(select coalesce(jsonb_agg(value order by dbid,classid,objid,objsubid,refclassid,refobjid,deptype),'[]'::jsonb)from shared)
)as inventory`;
