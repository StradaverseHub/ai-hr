/** Fixed dev-realm evidence grammar. No connection, provisioning or admission entry. */
import assert from 'node:assert/strict';

export const DEV_WORKLOAD_POSTGRES_PROFILE = 'linux-next-workload-dev-postgres-v1';
export const DEV_WORKLOAD_POSTGRES_DATABASE = 'ai_hr_dev';
export const DEV_WORKLOAD_POSTGRES_HBA = [
 'local all postgres trust',
 'local all all reject',
 'host postgres,ai_hr_dev postgres 127.0.0.1/32 scram-sha-256',
 'host ai_hr_dev ai_hr_app 127.0.0.1/32 scram-sha-256',
 'host ai_hr_dev ai_hr_workload_observer 127.0.0.1/32 scram-sha-256',
 'host all all all reject',
 '',
].join('\n');
export const DEV_WORKLOAD_POSTGRES_HBA_SHA256 = '1caaff1bdf965f2366636d60ac6f93ccc2d4de0a12b690e340dae3cadba4a945';

const ROLES = Object.freeze({owner:'postgres', app:'ai_hr_app', observer:'ai_hr_workload_observer'});
const ROLE_SLOTS = Object.freeze(Object.keys(ROLES));
const HOST = '127.0.0.1';
const PORT = 5433;
const MAX_OID = 4294967295;
const BINDING_KEYS = ['source','controller','runId','attempt','unit'];
const BIRTH_KEYS = ['binding','containerId','ownerNonce','processId','processBirth','cgroupDevice','cgroupInode',
 'systemIdentifierSha256','hbaSha256','databaseOid'];
const SESSION_KEYS = ['login','role','database','databaseOid','roleOid','pid','backendBirth',
 'clientAddress','clientPort','serverAddress','serverPort','superuser','bypassRls','createDb','createRole',
 'replication','connectionLimit','readOnly','isolation','statementTimeoutMs','lockTimeoutMs'];

// The future protected owner holds the DB and executes these exact statements
// under bounded client/transaction limits. These strings are inert source data.
export const DEV_WORKLOAD_POSTGRES_READS = Object.freeze({
 session: `SELECT session_user::text AS login, current_user::text AS role,
  d.datname::text AS database, d.oid::text AS "databaseOid", r.oid::text AS "roleOid",
  a.pid, extract(epoch FROM a.backend_start)::text AS "backendBirth",
  host(inet_client_addr()) AS "clientAddress", inet_client_port() AS "clientPort",
  host(inet_server_addr()) AS "serverAddress", inet_server_port() AS "serverPort",
  r.rolsuper AS superuser, r.rolbypassrls AS "bypassRls", r.rolcreatedb AS "createDb",
  r.rolcreaterole AS "createRole", r.rolreplication AS replication, r.rolconnlimit AS "connectionLimit",
  current_setting('transaction_read_only') = 'on' AS "readOnly",
  current_setting('transaction_isolation') AS isolation,
  (SELECT setting::int FROM pg_settings WHERE name='statement_timeout' AND unit='ms') AS "statementTimeoutMs",
  (SELECT setting::int FROM pg_settings WHERE name='lock_timeout' AND unit='ms') AS "lockTimeoutMs"
 FROM pg_stat_activity a JOIN pg_database d ON d.oid=a.datid
 JOIN pg_roles r ON r.rolname=current_user WHERE a.pid=pg_backend_pid()`,
 passwordKinds: `SELECT
  COALESCE(bool_or(rolpassword LIKE 'SCRAM-SHA-256$%') FILTER (WHERE rolname='postgres'),false) AS owner,
  COALESCE(bool_or(rolpassword LIKE 'SCRAM-SHA-256$%') FILTER (WHERE rolname='ai_hr_app'),false) AS app,
  COALESCE(bool_or(rolpassword LIKE 'SCRAM-SHA-256$%') FILTER (WHERE rolname='ai_hr_workload_observer'),false) AS observer
 FROM pg_authid WHERE rolname IN ('postgres','ai_hr_app','ai_hr_workload_observer')`,
 observerAcl: `WITH target AS (
  SELECT d.oid AS db, r.oid AS observer, s.oid AS stats
  FROM pg_database d CROSS JOIN pg_roles r CROSS JOIN pg_roles s
  WHERE d.datname='ai_hr_dev' AND current_database()=d.datname
    AND r.rolname='ai_hr_workload_observer' AND s.rolname='pg_read_all_stats'
 ), namespaces AS (
  SELECT oid FROM pg_namespace
  WHERE nspname NOT IN ('pg_catalog','information_schema')
    AND nspname !~ '^pg_(toast|temp)(_|$)'
 ), relations AS (
  SELECT c.oid,c.relkind FROM pg_class c JOIN namespaces n ON n.oid=c.relnamespace
  WHERE c.relkind IN ('r','p','v','m','f','S')
 ), stats_views AS (
  SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  JOIN pg_depend dep ON dep.classid='pg_class'::regclass AND dep.objid=c.oid AND dep.objsubid=0
    AND dep.refclassid='pg_extension'::regclass AND dep.refobjsubid=0 AND dep.deptype='e'
  JOIN pg_extension ext ON ext.oid=dep.refobjid AND ext.extnamespace=n.oid
  WHERE ext.extname='pg_stat_statements' AND n.nspname='public' AND c.relkind='v'
    AND c.relname IN ('pg_stat_statements','pg_stat_statements_info')
 ), definer_functions AS (
  SELECT oid,pronamespace FROM pg_proc WHERE prosecdef
 ), reset_function AS (
  SELECT to_regprocedure('public.pg_stat_statements_reset(oid,oid,bigint)') AS oid
 )
 SELECT db::text AS "databaseOid", observer::text AS "observerOid",
  (SELECT count(*)::int FROM namespaces) AS "schemasChecked",
  (SELECT count(*)::int FROM relations) AS "relationsChecked",
  (SELECT count(*)::int FROM pg_attribute a JOIN relations c ON c.oid=a.attrelid
    WHERE a.attnum>0 AND NOT a.attisdropped AND c.relkind<>'S') AS "columnsChecked",
  (SELECT count(*)::int FROM definer_functions) AS "definersChecked",
  (SELECT count(*)::int FROM stats_views v WHERE has_table_privilege(observer,v.oid,'SELECT')) AS "readableStatsViews",
  (SELECT count(*)::int FROM namespaces n WHERE has_schema_privilege(observer,n.oid,'CREATE')) AS "creatableSchemas",
  (SELECT count(*)::int FROM relations c WHERE CASE WHEN c.relkind='S'
    THEN has_sequence_privilege(observer,c.oid,'USAGE,SELECT,UPDATE')
    ELSE has_table_privilege(observer,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_any_column_privilege(observer,c.oid,'INSERT,UPDATE,REFERENCES')
      OR (NOT EXISTS (SELECT FROM stats_views v WHERE v.oid=c.oid)
        AND (has_table_privilege(observer,c.oid,'SELECT')
          OR has_any_column_privilege(observer,c.oid,'SELECT')))
    END) AS "unsafeRelations",
  (SELECT count(*)::int FROM definer_functions p
    WHERE has_schema_privilege(observer,p.pronamespace,'USAGE')
      AND has_function_privilege(observer,p.oid,'EXECUTE')) AS "callableDefiners",
  (SELECT count(*)::int FROM pg_auth_members WHERE member=observer) AS "directMemberships",
  (SELECT count(*)::int FROM pg_roles r WHERE r.oid NOT IN (observer,stats)
    AND pg_has_role(observer,r.oid,'MEMBER')) AS "otherMemberships",
  EXISTS (SELECT FROM pg_auth_members m JOIN pg_roles g ON g.oid=m.grantor
    WHERE m.member=observer AND m.roleid=stats AND g.rolname='postgres'
      AND m.inherit_option AND NOT m.set_option AND NOT m.admin_option) AS "exactStatsGrant",
  pg_has_role(observer,stats,'USAGE') AS "inheritsStats", pg_has_role(observer,stats,'SET') AS "setsStats",
  has_database_privilege(observer,db,'TEMPORARY') AS "canTemp",
  has_database_privilege(observer,db,'CREATE') AS "canCreateDatabaseObjects",
  reset_function.oid IS NOT NULL AS "resetExists",
  has_function_privilege(observer,reset_function.oid::oid,'EXECUTE') AS "canReset"
 FROM target CROSS JOIN reset_function`,
 statistics: `SELECT d.oid::text AS "databaseOid",
  (SELECT count(*)::int FROM pg_stat_activity a WHERE a.datid=d.oid AND a.usesysid=r.oid
    AND a.backend_type='client backend') AS "appBackends",
  (SELECT count(*)::int FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
    WHERE a.datid=d.oid AND a.usesysid=r.oid AND NOT l.granted) AS "appUngrantedLocks",
  (SELECT count(*)::int FROM public.pg_stat_statements p WHERE p.dbid=d.oid AND p.userid=r.oid) AS "appStatementRows"
 FROM pg_database d CROSS JOIN pg_roles r
 WHERE d.datname='ai_hr_dev' AND d.datname=current_database() AND r.rolname='ai_hr_app'`,
});

function closed(value, keys, reason){
 assert(value && Object.getPrototypeOf(value)===Object.prototype && Reflect.ownKeys(value).length===keys.length
  && keys.every(key=>Object.hasOwn(Object.getOwnPropertyDescriptor(value,key)??{},'value')),reason);
}
const decimal = value => typeof value==='string' && /^[1-9][0-9]{0,19}(?![\s\S])/.test(value);
const oid = value => decimal(value) && Number(value)<=MAX_OID;
const integer = (value,min,max) => Number.isSafeInteger(value) && value>=min && value<=max;
const digest = (value,size=64) => typeof value==='string' && value.length===size && /^[a-f0-9]+(?![\s\S])/.test(value);

/** Observe syntax and separation privately. No URL is returned or included in a failure. */
export function validateDevWorkloadCredentials(urls){
 closed(urls,ROLE_SLOTS,'Closed dev workload credential slots required');
 const passwords=ROLE_SLOTS.map(slot=>{
  const prefix='postgres://'+ROLES[slot]+':', suffix='@127.0.0.1:5433/ai_hr_dev';
  const raw=urls[slot];
  assert(typeof raw==='string' && raw.startsWith(prefix) && raw.endsWith(suffix)
   && raw.length===prefix.length+64+suffix.length,'Dev workload credential target refused');
  const password=raw.slice(prefix.length,prefix.length+64);
  assert(digest(password),'Dev workload credential form refused');
  return password;
 });
 assert(new Set(passwords).size===ROLE_SLOTS.length,'Dev workload credential separation refused');
}

export function validateDevWorkloadPasswordKinds(row){
 closed(row,ROLE_SLOTS,'Closed dev workload password kind census required');
 assert(ROLE_SLOTS.every(slot=>row[slot]===true),'Dev workload SCRAM verifier evidence refused');
}

function validateBinding(value){
 closed(value,BINDING_KEYS,'Closed dev workload binding required');
 assert(digest(value.source,40) && digest(value.controller,40) && integer(value.runId,1,Number.MAX_SAFE_INTEGER)
  && value.attempt===1 && typeof value.unit==='string' && /^db-[a-f0-9]{16}(?![\s\S])/.test(value.unit),
 'Dev workload binding refused');
}

/** These bindings are compared only after the future protected owner has independently observed them. */
export function validateDevWorkloadBirth(proof,expectedBinding){
 validateBinding(expectedBinding);
 closed(proof,BIRTH_KEYS,'Closed dev workload process birth required');
 validateBinding(proof.binding);
 assert(BINDING_KEYS.every(key=>proof.binding[key]===expectedBinding[key]),'Dev workload process binding differs');
 assert(digest(proof.containerId) && digest(proof.ownerNonce) && integer(proof.processId,2,4194304)
  && decimal(proof.processBirth) && decimal(proof.cgroupDevice) && decimal(proof.cgroupInode)
  && digest(proof.systemIdentifierSha256) && proof.hbaSha256===DEV_WORKLOAD_POSTGRES_HBA_SHA256 && oid(proof.databaseOid),
 'Dev workload process identity refused');
}

function validateSession(row,role,databaseOid){
 closed(row,SESSION_KEYS,'Closed dev workload TCP session required');
 assert(row.login===role && row.role===role && row.database===DEV_WORKLOAD_POSTGRES_DATABASE
  && row.databaseOid===databaseOid && oid(row.roleOid) && integer(row.pid,2,4194304)
  && typeof row.backendBirth==='string' && /^[1-9][0-9]{0,19}(?:\.[0-9]{1,9})?(?![\s\S])/.test(row.backendBirth)
  && row.clientAddress===HOST && row.serverAddress===HOST && row.serverPort===PORT && integer(row.clientPort,1,65535),
 'Dev workload TCP identity refused');
 const privileged=['superuser','bypassRls','createDb','createRole','replication'];
 assert(privileged.every(key=>typeof row[key]==='boolean') && row.superuser===(role===ROLES.owner)
  && (role===ROLES.owner || privileged.every(key=>row[key]===false)), 'Dev workload TCP role refused');
 assert(typeof row.readOnly==='boolean' && ['read committed','repeatable read'].includes(row.isolation)
  && integer(row.connectionLimit,-1,100) && row.statementTimeoutMs===2000 && row.lockTimeoutMs===300,
 'Dev workload TCP limits refused');
 if(role===ROLES.observer)assert(row.readOnly && row.isolation==='repeatable read' && row.connectionLimit===2,
  'Dev workload observer transaction refused');
}

export function validateDevWorkloadSessions(before,after,physicalDatabaseOid){
 assert(oid(physicalDatabaseOid),'Dev workload physical database OID refused');
 for(const sessions of [before,after]){
  closed(sessions,ROLE_SLOTS,'Closed dev workload TCP role census required');
  for(const slot of ROLE_SLOTS)validateSession(sessions[slot],ROLES[slot],physicalDatabaseOid);
  for(const key of ['pid','roleOid','clientPort'])
   assert(new Set(ROLE_SLOTS.map(slot=>sessions[slot][key])).size===ROLE_SLOTS.length,'Dev workload TCP sessions collide');
 }
 assert(ROLE_SLOTS.every(slot=>SESSION_KEYS.every(key=>before[slot][key]===after[slot][key])),
  'Dev workload TCP session changed during observation');
}

export function validateDevWorkloadObserverAcl(acl,physicalDatabaseOid,heldObserverOid){
 closed(acl,['databaseOid','observerOid','schemasChecked','relationsChecked','columnsChecked','definersChecked',
  'readableStatsViews','creatableSchemas','unsafeRelations','callableDefiners','directMemberships','otherMemberships','exactStatsGrant',
  'inheritsStats','setsStats','canTemp','canCreateDatabaseObjects','resetExists','canReset'],'Closed dev workload observer ACL required');
 assert(oid(physicalDatabaseOid) && oid(heldObserverOid) && acl.databaseOid===physicalDatabaseOid && acl.observerOid===heldObserverOid,
  'Dev workload observer ACL identity refused');
 assert(integer(acl.schemasChecked,1,128) && integer(acl.relationsChecked,3,8192)
  && integer(acl.columnsChecked,3,131072) && integer(acl.definersChecked,0,8192) && acl.readableStatsViews===2,
 'Dev workload observer ACL census refused');
 assert(acl.creatableSchemas===0 && acl.unsafeRelations===0 && acl.callableDefiners===0
  && acl.directMemberships===1 && acl.otherMemberships===0 && acl.exactStatsGrant===true && acl.inheritsStats===true && acl.setsStats===false
  && acl.canTemp===false && acl.canCreateDatabaseObjects===false && acl.resetExists===true && acl.canReset===false,
 'Dev workload observer effective authority refused');
}

export function validateDevWorkloadStatistics(row,physicalDatabaseOid){
 closed(row,['databaseOid','appBackends','appUngrantedLocks','appStatementRows'],'Closed dev workload statistics required');
 assert(oid(physicalDatabaseOid) && row.databaseOid===physicalDatabaseOid && integer(row.appBackends,1,100)
  && integer(row.appUngrantedLocks,0,100000) && integer(row.appStatementRows,1,10000),'Dev workload statistics scope refused');
}

const REFUSALS = Object.freeze({
 ownerMissingPassword:'28P01', appMissingPassword:'28P01', observerMissingPassword:'28P01',
 appAsOwner:'28P01', observerAsOwner:'28P01', appForeignDb:'28000', observerForeignDb:'28000',
 observerBusinessTable:'42501', observerReset:'42501', observerSetOwner:'42501',
 observerSetStats:'42501', observerTemp:'42501',
});

export function validateDevWorkloadRefusals(rows){
 closed(rows,Object.keys(REFUSALS),'Closed dev workload refusal census required');
 assert(Object.entries(REFUSALS).every(([key,code])=>rows[key]===code),'Dev workload refusal evidence differs');
}

/** Cleanup is separately joined to the held birth, never inferred from a successful query. */
export function validateDevWorkloadSettlement(row,birth,expectedBinding){
 closed(row,['containerId','processId','processBirth','cgroupDevice','cgroupInode','systemIdentifierSha256',
  'databaseOid','clientsClosed','containerAbsent','processAbsent','cgroupAbsent','listenerAbsent','privateFilesRemoved'],
 'Closed dev workload settlement required');
 validateDevWorkloadBirth(birth,expectedBinding);
 assert(['containerId','processId','processBirth','cgroupDevice','cgroupInode','systemIdentifierSha256','databaseOid']
  .every(key=>row[key]===birth[key]),'Dev workload settlement birth differs');
 assert(row.clientsClosed===ROLE_SLOTS.length && ['containerAbsent','processAbsent','cgroupAbsent','listenerAbsent','privateFilesRemoved']
  .every(key=>row[key]===true),'Dev workload settlement incomplete');
}
