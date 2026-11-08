/** Fixed disposable native custody. Never imported by an app or purpose worker. */
import assert from 'node:assert/strict';
import {writeFileSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import type {TransactionSql} from 'postgres';
import type {RewardsAuditOwnerDependencies} from './rewards-audited-read-owner-factory';
import {rewardsAuditOwnerConfiguration} from './rewards-audit-fixture-context';
import {admitAuditCanonicalization,captureAuditDefault,referenceAuditCanonicalization,assertAuditCanonicalTransition,type AuditNativeSnapshot} from './rewards-audit-native-postimage';
import {privateAuditDefaultController,type AuditDefaultControl} from './rewards-audit-default-controller-process';
import {defaultControllerApplication,type DefaultControllerIdentity} from './rewards-audit-default-controller-protocol';
import {pgSqlState} from '../../lib/db-error';
type Control=AuditDefaultControl&Readonly<{evidenceDirectory:string}>;
export async function establishAuditCanonicalCustody(dependencies:RewardsAuditOwnerDependencies,control:Control,poison:(error:Error)=>void){
 const {migration,database}=rewardsAuditOwnerConfiguration(),login=decodeURIComponent(migration.username),{owner}=dependencies;
 await dependencies.migrateTestDb();control.signal.throwIfAborted();
 const before=await owner.client.begin(async tx=>{const original=await admitAuditCanonicalization(tx,database,login);const canonical=await referenceAuditCanonicalization(tx,original);return{original,canonical};});
 const observations:unknown[]=[],hostile:unknown[]=[];let uncertain=false;
 const source=process.env.AIHR_CI_HEAD,runId=process.env.GITHUB_RUN_ID,attempt=process.env.GITHUB_RUN_ATTEMPT;assert(typeof source==='string'&&/^[a-f0-9]{40}$/.test(source));assert(typeof runId==='string'&&/^[1-9][0-9]{0,19}$/.test(runId));assert(typeof attempt==='string'&&/^[1-9][0-9]*$/.test(attempt));
 const evidence=()=>{const directory=realpathSync(control.evidenceDirectory);assert.equal(directory,resolve(control.evidenceDirectory));writeFileSync(join(directory,'rewards-policy-native-default-postimages.json'),JSON.stringify({kind:'UNINSTALLED_NATIVE_DEFAULT_POSTIMAGES',releaseAuthorized:false,source,runId,attempt,database,original:before.original,canonical:before.canonical,hostile,observations,outcomeUnknown:uncertain},null,2)+'\n',{mode:0o600});};
 async function refused(name:string,change:(tx:TransactionSql)=>Promise<unknown>){
  const sentinel=Error('Hostile declaration unexpectedly admitted');
  const result=await owner.client.begin(async tx=>{await change(tx);await admitAuditCanonicalization(tx,database,login);throw sentinel;}).then(()=>undefined,(error:unknown)=>error);
  assert.equal(pgSqlState(result),'55000',name);assert.deepEqual(await captureAuditDefault(owner.client),before.original);hostile.push({name,sqlstate:'55000',fullOriginalRestored:true});
 }
 evidence();
 try{
 // All mutations are actual native, controlled and rolled back. No guard mock,
 // edited AST, omitted catalog field or empirically recaptured expected image.
 const declaration=before.original.row.definition;assert.equal(declaration.split('DEFAULT false').length,2);assert.equal(declaration.split(before.original.row.body).length,2);
 await refused('default-true',tx=>tx.unsafe(declaration.replace('DEFAULT false','DEFAULT true')));
 await refused('extra-ABI',tx=>tx`create function app._domain_event_next(uuid,integer)returns jsonb language sql as 'select null::jsonb'`);
 await refused('wrong-default-type',tx=>tx`create function app._domain_event_next(uuid,text default 'false')returns jsonb language sql as 'select null::jsonb'`);
 await refused('body-drift',tx=>tx.unsafe(declaration.replace(before.original.row.body,before.original.row.body+'\n-- hostile native body\n')));
 await refused('ACL-drift',tx=>tx`grant execute on function app._domain_event_next(uuid,boolean)to ai_hr_app`);
 await refused('owner-drift',tx=>tx`alter function app._domain_event_next(uuid,boolean)owner to ai_hr_app`);
 await refused('configuration-drift',tx=>tx`alter function app._domain_event_next(uuid,boolean)set search_path=pg_catalog`);
 await refused('support-drift',tx=>tx`alter function app._domain_event_next(uuid,boolean)support pg_catalog.array_unnest_support`);
 const rejectUnexpected=Error('Unexpected postimage was accepted');
 const unexpected=await owner.client.begin(async tx=>{await tx`alter function app._domain_event_next(uuid,boolean)cost 101`;assertAuditCanonicalTransition(before.original,await captureAuditDefault(tx));throw rejectUnexpected;}).then(()=>undefined,(error:unknown)=>error);
 assert(unexpected instanceof assert.AssertionError);assert.notEqual(unexpected,rejectUnexpected);assert.deepEqual(await captureAuditDefault(owner.client),before.original);hostile.push({name:'unexpected-full-postimage',nativeChanged:true,comparisonRefused:true,fullOriginalRestored:true});
 async function prepared(identity:DefaultControllerIdentity,nonce:string){
  assert.equal(identity.kind,'prepared');assert.equal(identity.nonce,nonce);assert.equal(identity.database,database);assert.equal(identity.role,login);
  const [actual]=await owner.client`with parent as materialized(select pg_current_xact_id()as xid)select s.pid=${identity.pid} and s.backend_start=${identity.started}::text::timestamptz and s.datname=${database} and s.usename=${login} and s.application_name=${defaultControllerApplication(nonce)} and s.backend_xid=${identity.xid}::text::xid8::xid as exact,
   pg_xact_status(${identity.xid}::text::xid8)as status,${identity.xid}::text::xid8<parent.xid and exists(select 1 from pg_snapshot_xip(pg_current_snapshot())as active(xid) where active.xid=${identity.xid}::text::xid8)as active from pg_stat_activity s cross join parent where s.pid=${identity.pid}`;
  assert.deepEqual(actual,{exact:true,status:'in progress',active:true});assert.deepEqual(await captureAuditDefault(owner.client),before.original);
 }
 async function reconciled(identity:DefaultControllerIdentity,expected:AuditNativeSnapshot,status:'aborted'|'committed'){
  const deadline=performance.now()+2000;
  do{control.signal.throwIfAborted();const [actual]=await owner.client`select not exists(select 1 from pg_stat_activity where pid=${identity.pid} and backend_start=${identity.started}::text::timestamptz and datname=${database} and usename=${login})as absent,pg_xact_status(${identity.xid}::text::xid8)as status`;
   if(actual.absent===true){assert.equal(actual.status,status);assert.deepEqual(await captureAuditDefault(owner.client),expected);uncertain=false;observations.push({identity,status,backendAbsent:true,fullPostimage:true});evidence();return;}
   assert(performance.now()<deadline,'Exact child backend drain missing');await new Promise<void>(resolve=>setTimeout(resolve,5));
  }while(true);
 }
  // No base factory can snapshot while this private outcome fence is open.
  const aborted=privateAuditDefaultController(migration.toString(),control,poison);
  await aborted.run(async()=>{const identity=await aborted.wait('prepared');await prepared(identity,aborted.nonce);uncertain=true;evidence();const closed=await aborted.stop();assert.deepEqual(closed,{code:null,signal:'SIGKILL'});await reconciled(identity,before.original,'aborted');});
  const committed=privateAuditDefaultController(migration.toString(),control,poison);
  await committed.run(async()=>{const identity=await committed.wait('prepared');await prepared(identity,committed.nonce);uncertain=true;evidence();committed.advance();const notice=await committed.wait('committed');assert.deepEqual({...notice,kind:'prepared'},identity);
   // Native status/image, not the IPC notice, establishes committed custody.
   const [actual]=await owner.client`select pg_xact_status(${identity.xid}::text::xid8)as status`;assert.equal(actual.status,'committed');assert.deepEqual(await captureAuditDefault(owner.client),before.canonical);
   const closed=await committed.stop();assert.deepEqual(closed,{code:null,signal:'SIGKILL'});await reconciled(identity,before.canonical,'committed');});
  assert.equal(uncertain,false);assert.equal(observations.length,2);assert.deepEqual(await captureAuditDefault(owner.client),before.canonical);evidence();
 }catch(error){uncertain=true;try{evidence();}catch(publication){throw new AggregateError([error,publication],'Native custody and evidence publication failed',{cause:error});}finally{poison(Error('Native canonical custody unresolved; base admission refused',{cause:error}));}throw error;}
 // Child two is killed after PG COMMIT and before SERVICE completion. This is
 // not a claim to simulate a lost PostgreSQL protocol-level COMMIT ACK.
 return Object.freeze(before);
}
