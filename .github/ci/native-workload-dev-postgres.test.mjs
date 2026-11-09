/** Model controls only. No native database, credential, command or permission changes. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {NATIVE_WORKLOAD_DATABASE_HBA} from './singleton-protocol.mjs';
import {
 DEV_WORKLOAD_POSTGRES_DATABASE, DEV_WORKLOAD_POSTGRES_HBA, DEV_WORKLOAD_POSTGRES_HBA_SHA256,
 DEV_WORKLOAD_POSTGRES_PROFILE, DEV_WORKLOAD_POSTGRES_READS, validateDevWorkloadBirth,
 validateDevWorkloadCredentials, validateDevWorkloadObserverAcl, validateDevWorkloadPasswordKinds,
 validateDevWorkloadRefusals, validateDevWorkloadSessions, validateDevWorkloadSettlement,
 validateDevWorkloadStatistics,
} from './native-workload-dev-postgres.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const binding={source:'a'.repeat(40),controller:'b'.repeat(40),runId:123,attempt:1,unit:'db-0123456789abcdef'};
const systemIdentifier='7354182341226312455';
const birth={
 binding,containerId:'a'.repeat(64),ownerNonce:'b'.repeat(64),processId:501,processBirth:'1234',cgroupDevice:'37',cgroupInode:'987',
 systemIdentifierSha256:sha(systemIdentifier),hbaSha256:DEV_WORKLOAD_POSTGRES_HBA_SHA256,databaseOid:'16001',
};
const roleNames=['postgres','ai_hr_app','ai_hr_workload_observer'];
const credential=(role,letter)=>`postgres://${role}:${letter.repeat(64)}@127.0.0.1:5433/ai_hr_dev`;
const creds=()=>Object.fromEntries(['owner','app','observer'].map((slot,index)=>[slot,credential(roleNames[index],'abc'[index])]));
const tcp=(slot,index)=>({
 login:roleNames[index],role:roleNames[index],database:'ai_hr_dev',databaseOid:birth.databaseOid,
 roleOid:String(16010+index),pid:601+index,backendBirth:'1794250000.012345',
 clientAddress:'127.0.0.1',clientPort:32000+index,serverAddress:'127.0.0.1',serverPort:5433,
 superuser:slot==='owner',bypassRls:slot==='owner',createDb:slot==='owner',createRole:slot==='owner',
 replication:slot==='owner',connectionLimit:slot==='observer'?2:-1,readOnly:slot==='observer',
 isolation:slot==='observer'?'repeatable read':'read committed',statementTimeoutMs:2000,lockTimeoutMs:300,
 transactionBirth:'1794250001.012345',virtualTransaction:(10+index)+'/1',
});
const sessions=()=>Object.fromEntries(['owner','app','observer'].map((slot,index)=>[slot,tcp(slot,index)]));
const observation=(held=sessions(),overrides={})=>({
 sessions:held,ownerCluster:{pid:held.owner.pid,backendBirth:held.owner.backendBirth,databaseOid:held.owner.databaseOid,
  systemIdentifier,...overrides},
});
const acl={
 databaseOid:birth.databaseOid,observerOid:'16012',schemasChecked:5,relationsChecked:600,columnsChecked:5500,definersChecked:87,
 readableStatsViews:2,creatableSchemas:0,unsafeRelations:0,callableDefiners:0,directMemberships:1,otherMemberships:0,
 exactStatsGrant:true,inheritsStats:true,setsStats:false,canTemp:false,canCreateDatabaseObjects:false,resetExists:true,canReset:false,
 ownsDatabase:false,ownedSchemas:0,ownedRelations:0,ownedFunctions:0,catalogueRelationsChecked:410,sensitiveCatalogueChecked:11,
 sensitiveCatalogueReadable:0,unexpectedCatalogueGrants:0,unexpectedCatalogueColumnGrants:0,catalogueWriteRights:0,
 catalogueRoutinesChecked:3500,restrictedRoutinesChecked:60,restrictedRoutinesExecutable:0,
 executableStockStatsRoutines:2,stockStatsRoutineGrants:2,unexpectedCatalogueRoutineGrants:0,
};
const stats={databaseOid:birth.databaseOid,appBackends:1,appUngrantedLocks:0,appStatementRows:1};
const refusals={
 ownerMissingPassword:'28P01',appMissingPassword:'28P01',observerMissingPassword:'28P01',
 appAsOwner:'28P01',observerAsOwner:'28P01',appForeignDb:'28000',observerForeignDb:'28000',
 observerBusinessTable:'42501',observerReset:'42501',observerSetOwner:'42501',observerSetStats:'42501',observerTemp:'42501',
};
const settled={
 containerId:birth.containerId,processId:birth.processId,processBirth:birth.processBirth,
 cgroupDevice:birth.cgroupDevice,cgroupInode:birth.cgroupInode,systemIdentifierSha256:birth.systemIdentifierSha256,
 databaseOid:birth.databaseOid,clientsClosed:3,containerAbsent:true,processAbsent:true,cgroupAbsent:true,
 listenerAbsent:true,privateFilesRemoved:true,
};

test('dev realm HBA has exact physical scope and preserves the old test worker HBA bytes',()=>{
 assert.equal(DEV_WORKLOAD_POSTGRES_PROFILE,'linux-next-workload-dev-postgres-v1');
 assert.equal(DEV_WORKLOAD_POSTGRES_DATABASE,'ai_hr_dev');
 assert.equal(Buffer.byteLength(DEV_WORKLOAD_POSTGRES_HBA),248);
 assert.equal(sha(DEV_WORKLOAD_POSTGRES_HBA),DEV_WORKLOAD_POSTGRES_HBA_SHA256);
 assert.equal(Buffer.byteLength(NATIVE_WORKLOAD_DATABASE_HBA),296);
 assert.equal(sha(NATIVE_WORKLOAD_DATABASE_HBA),'c3ba3db9759c83063574fa8024458c260f6a4d008914a4c1c3e66de3e86ad524');
 assert(DEV_WORKLOAD_POSTGRES_HBA.includes('host ai_hr_dev ai_hr_workload_observer 127.0.0.1/32 scram-sha-256'));
 assert(NATIVE_WORKLOAD_DATABASE_HBA.includes('host ai_hr_test_w1 ai_hr_workload_observer 127.0.0.1/32 scram-sha-256'));
 assert(!DEV_WORKLOAD_POSTGRES_HBA.includes('ai_hr_test'));
});

test('private credential grammar refuses any other transport, target, slot or reused password without returning credentials',()=>{
 assert.equal(validateDevWorkloadCredentials(creds()),undefined);
 const sample=creds();
 for(const change of [
  {observer:sample.observer.replace('/ai_hr_dev','/ai_hr_test_w1')},
  {observer:sample.observer.replace('127.0.0.1','localhost')},
  {observer:sample.observer.replace(':5433',':5432')},
  {observer:sample.observer+'\n'}, {observer:sample.observer+'?application_name=x'},
  {observer:credential(roleNames[2],'b')}, {observer:sample.app},
  {owner:'postgres://postgres@127.0.0.1:5433/ai_hr_dev'}, {environment:sample},
 ])assert.throws(()=>validateDevWorkloadCredentials({...sample,...change}),error=>
  !/postgres:\/\/|[abc]{64}/.test(error.message) && /credential/.test(error.message));
 const accessor={...sample};Object.defineProperty(accessor,'owner',{get(){throw Error('must not be read');}});
 assert.throws(()=>validateDevWorkloadCredentials(accessor),/credential slots/);
});

test('SCRAM verifier observation consists of exactly three booleans and never verifier strings',()=>{
 validateDevWorkloadPasswordKinds({owner:true,app:true,observer:true});
 for(const row of [{owner:true,app:true,observer:false},{owner:true,app:true},{owner:true,app:true,observer:'SCRAM-SHA-256$'}])
  assert.throws(()=>validateDevWorkloadPasswordKinds(row),/dev workload (password kind|SCRAM verifier)/i);
});

test('independent physical birth must bind exact source, controller, first attempt, run, unit and dev HBA',()=>{
 validateDevWorkloadBirth(birth,{...binding});
 for(const change of [{source:'c'.repeat(40)},{controller:'d'.repeat(40)},{runId:124},{attempt:2},{unit:'db-fedcba9876543210'}])
  assert.throws(()=>validateDevWorkloadBirth(birth,{...binding,...change}),/binding/);
 for(const change of [{databaseOid:'4294967296'},{processId:0},{processBirth:'0001'},{cgroupInode:'1\n'},{hbaSha256:sha(NATIVE_WORKLOAD_DATABASE_HBA)}])
  assert.throws(()=>validateDevWorkloadBirth({...birth,...change},binding),/process identity/);
});

test('owner, RLS app and stats roles must use stable distinct dev TCP connections on both observations',()=>{
 validateDevWorkloadSessions(observation(),observation(),birth,binding);
 const before=sessions();
 for(const change of [{database:'ai_hr_test_w1'},{databaseOid:'16002'},{login:'postgres'},{role:'postgres'},
  {serverAddress:'::1'},{clientAddress:'127.0.0.2'},{serverPort:5432},{superuser:true},{bypassRls:true},
  {pid:before.owner.pid},{roleOid:before.owner.roleOid},{clientPort:before.owner.clientPort},
  {pid:612},{backendBirth:'1794250000.654321'}])
  assert.throws(()=>validateDevWorkloadSessions(observation(before),observation({...before,app:{...before.app,...change}}),birth,binding),/TCP/);
});

test('observer requires held repeatable read, read-only, connection cap and short statement and lock limits',()=>{
 const before=sessions();
 for(const change of [{readOnly:false},{isolation:'read committed'},{connectionLimit:3},{lockTimeoutMs:1000},{statementTimeoutMs:20000}])
  assert.throws(()=>validateDevWorkloadSessions(observation(before),observation({...before,observer:{...before.observer,...change}}),birth,binding),
   /observer transaction|TCP limits/);
});

test('reserved owner TCP snapshots must independently match the held physical cluster even when endpoint and OIDs match',()=>{
 const held=sessions(),before=observation(held);
 for(const change of [{systemIdentifier:'7354182341226312456'},{systemIdentifier:'18446744073709551616'},
  {pid:held.owner.pid+1},{backendBirth:'1794250000.000012'},{databaseOid:'16002'}]){
  const foreign=observation(held,change);
  for(const [first,last] of [[before,foreign],[foreign,before]])
   assert.throws(()=>validateDevWorkloadSessions(first,last,birth,binding),error=>
    /owner TCP cluster/.test(error.message) && !error.message.includes(systemIdentifier)
    && !error.message.includes('7354182341226312456'));
 }
});

test('another repeatable read transaction on the same live observer backend does not retain the held observation',()=>{
 const held=sessions(),before=observation(held);
 const renew=change=>observation({...held,observer:{...held.observer,...change}});
 validateDevWorkloadSessions(before,observation(held),birth,binding);
 for(const change of [{virtualTransaction:'12/2'},{transactionBirth:'1794250001.012346'}])
  assert.throws(()=>validateDevWorkloadSessions(before,renew(change),birth,binding),/held observer transaction changed/);
 for(const change of [{virtualTransaction:null},{virtualTransaction:'12/1\n'},{transactionBirth:'0'}])
  assert.throws(()=>validateDevWorkloadSessions(before,renew(change),birth,binding),/TCP transaction refused/);
});

test('effective observer ACL refuses PUBLIC TEMP, unsafe role edges, table or definer rights and absent reset evidence',()=>{
 validateDevWorkloadObserverAcl(acl,birth.databaseOid,'16012');
 for(const change of [{canTemp:true},{canCreateDatabaseObjects:true},{creatableSchemas:1},{unsafeRelations:1},
  {callableDefiners:1},{canReset:true},{canReset:null},{resetExists:false},{directMemberships:2},
  {otherMemberships:1},{exactStatsGrant:false},{inheritsStats:false},{setsStats:true}])
  assert.throws(()=>validateDevWorkloadObserverAcl({...acl,...change},birth.databaseOid,'16012'),/effective authority/);
});

test('ACL observations are bound to the held database and role and refuse unknown inventory bounds',()=>{
 assert.throws(()=>validateDevWorkloadObserverAcl(acl,birth.databaseOid,'16013'),/ACL identity/);
 assert.throws(()=>validateDevWorkloadObserverAcl(acl,'16002','16012'),/ACL identity/);
 for(const change of [{schemasChecked:0},{relationsChecked:8193},{columnsChecked:131073},{definersChecked:8193},
  {catalogueRelationsChecked:8193},{sensitiveCatalogueChecked:10},
  {readableStatsViews:1}])
  assert.throws(()=>validateDevWorkloadObserverAcl({...acl,...change},birth.databaseOid,'16012'),/ACL census/);
 assert.throws(()=>validateDevWorkloadObserverAcl({...acl,unknown:true},birth.databaseOid,'16012'),/Closed/);
});

test('observer ownership and unsafe catalogue access refuse even when ordinary business ACL grants are absent',()=>{
 for(const change of [{ownsDatabase:true},{ownedSchemas:1},{ownedRelations:1},{ownedFunctions:1}])
  assert.throws(()=>validateDevWorkloadObserverAcl({...acl,...change},birth.databaseOid,'16012'),/observer ownership/);
 for(const change of [{sensitiveCatalogueReadable:1},{unexpectedCatalogueGrants:1},
  {unexpectedCatalogueColumnGrants:1},{catalogueWriteRights:1}])
  assert.throws(()=>validateDevWorkloadObserverAcl({...acl,...change},birth.databaseOid,'16012'),/observer catalogue access/);
 assert.match(DEV_WORKLOAD_POSTGRES_READS.observerAcl,/pg_has_role\(t.observer,r.oid,'USAGE'\) OR pg_has_role\(t.observer,r.oid,'SET'\)/);
 assert.match(DEV_WORKLOAD_POSTGRES_READS.observerAcl,/\('pg_subscription','subconninfo'\)/);
 assert.match(DEV_WORKLOAD_POSTGRES_READS.observerAcl,/acl.grantee=stats AND acl.grantor=postgres_owner/);
 assert.match(DEV_WORKLOAD_POSTGRES_READS.observerAcl,/ext.extname='pg_stat_statements'/);
});

test('catalogue routine ACL refuses restored PUBLIC access or extra explicit edges while preserving exact stock stats grants',()=>{
 validateDevWorkloadObserverAcl(acl,birth.databaseOid,'16012');
 for(const change of [{catalogueRoutinesChecked:61},{catalogueRoutinesChecked:8193},
  {restrictedRoutinesChecked:59},{restrictedRoutinesChecked:61}])
  assert.throws(()=>validateDevWorkloadObserverAcl({...acl,...change},birth.databaseOid,'16012'),/routine census/);
 for(const change of [{restrictedRoutinesExecutable:1},{unexpectedCatalogueRoutineGrants:1},
  {executableStockStatsRoutines:1},{stockStatsRoutineGrants:1},{stockStatsRoutineGrants:3}])
  assert.throws(()=>validateDevWorkloadObserverAcl({...acl,...change},birth.databaseOid,'16012'),/routine authority/);
 const {restrictedRoutinesExecutable:missing,...incomplete}=acl;
 assert.equal(missing,0);
 assert.throws(()=>validateDevWorkloadObserverAcl(incomplete,birth.databaseOid,'16012'),/Closed/);
 const sql=DEV_WORKLOAD_POSTGRES_READS.observerAcl;
 const signatures=[...sql.matchAll(/\('pg_catalog\.(\w+\([^']*\))'\)/g)].map(match=>match[1]);
 assert.equal(new Set(signatures).size,62);
 assert(signatures.includes('pg_read_file(text,bigint,bigint)'));
 assert(signatures.includes('pg_read_binary_file(text,bigint,bigint,boolean)'));
 assert(signatures.includes('pg_show_all_file_settings()'));
 assert.match(sql,/FROM restricted_routines p\s+WHERE pg_catalog\.has_function_privilege\(observer,p\.oid,'EXECUTE'\)/);
 assert.match(sql,/pg_catalog\.aclexplode\(p\.proacl\)/);
 assert.match(sql,/acl\.grantee=t\.stats AND acl\.grantor=t\.postgres_owner\s+AND acl\.privilege_type='EXECUTE' AND NOT acl\.is_grantable/);
 assert.match(sql,/acl\.grantee IN \(SELECT oid FROM effective_roles\) OR \(acl\.grantee=0 AND stock\.oid IS NOT NULL\)/);
 assert(signatures.includes('pg_get_shmem_allocations()'));
 assert(signatures.includes('pg_get_backend_memory_contexts()'));
});

test('only closed same-realm aggregate app observations with positive live activity can be retained',()=>{
 validateDevWorkloadStatistics(stats,birth.databaseOid);
 for(const row of [{...stats,databaseOid:'16002'},{...stats,appBackends:0},{...stats,appStatementRows:0},
  {...stats,appUngrantedLocks:-1},{...stats,query:'select subject'}])
  assert.throws(()=>validateDevWorkloadStatistics(row,birth.databaseOid),/statistics/);
 assert(!/\b(query|rolpassword)\b/.test(DEV_WORKLOAD_POSTGRES_READS.statistics));
 assert.match(DEV_WORKLOAD_POSTGRES_READS.statistics,/p\.dbid=d\.oid AND p\.userid=r\.oid/);
});

test('actual refusal categories distinguish wrong auth, foreign realm and server-denied privileges',()=>{
 validateDevWorkloadRefusals(refusals);
 for(const change of [{ownerMissingPassword:'ECONNREFUSED'},{observerForeignDb:'28P01'},
  {observerBusinessTable:'42P01'},{observerReset:'unexpected-success'},{observerTemp:'25006'},{other:'42501'}])
  assert.throws(()=>validateDevWorkloadRefusals({...refusals,...change}),/refusal/);
});

test('successful observation cannot replace cleanup tied to the held physical birth',()=>{
 validateDevWorkloadSettlement(settled,birth,binding);
 for(const change of [{clientsClosed:2},{containerAbsent:false},{processAbsent:false},{cgroupAbsent:false},
  {listenerAbsent:false},{privateFilesRemoved:false},{processBirth:'8888'},{containerId:'d'.repeat(64)},
  {cgroupDevice:'57'},{databaseOid:'16002'}])
  assert.throws(()=>validateDevWorkloadSettlement({...settled,...change},birth,binding),/settlement/);
 assert.throws(()=>validateDevWorkloadSettlement(settled,birth,{...binding,runId:124}),/binding/);
});

test('native observation statements are finite reads and expose no password or query text',()=>{
 assert.deepEqual(Object.keys(DEV_WORKLOAD_POSTGRES_READS),['session','ownerClusterIdentity','passwordKinds','observerAcl','statistics']);
 assert(Object.isFrozen(DEV_WORKLOAD_POSTGRES_READS));
 for(const statement of Object.values(DEV_WORKLOAD_POSTGRES_READS)){
  assert.match(statement,/^(SELECT|WITH)\s/);
  assert(!statement.includes(';'));
 }
 assert.match(DEV_WORKLOAD_POSTGRES_READS.passwordKinds,/bool_or\(rolpassword LIKE 'SCRAM-SHA-256\$%'/);
 assert.match(DEV_WORKLOAD_POSTGRES_READS.ownerClusterIdentity,/a.pid=pg_backend_pid\(\) AND session_user='postgres' AND current_user='postgres'/);
 assert.match(DEV_WORKLOAD_POSTGRES_READS.session,/l.virtualxid=l.virtualtransaction/);
 assert.match(DEV_WORKLOAD_POSTGRES_READS.observerAcl,/has_database_privilege\(observer,db,'TEMPORARY'\)/);
 assert.match(DEV_WORKLOAD_POSTGRES_READS.observerAcl,/to_regprocedure\('public\.pg_stat_statements_reset\(oid,oid,bigint\)'\)/);
});
