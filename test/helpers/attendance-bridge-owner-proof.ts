/** Runs only inside the disposable child. Never imported by application code. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import postgres from 'postgres';
import {sql} from 'drizzle-orm';
import {withTenant} from '../../db/client';
import * as s from '../../db/schema';
import {owner} from '../harness';
import {attendanceBridgeFixture,type BridgeStep} from './attendance-bridge-fixture';
import {BRIDGE_SNAPSHOT,bridgeSnapshot,assertCreatedRole,guardedOwnerBatch,quoteBridgeRole,type OwnerSnapshot} from './attendance-bridge-owner-catalogue';
import {OwnerRefusal,type OwnerInput,type OwnerWorkFrontier,type OwnerReport,type OwnerStage} from './attendance-bridge-owner-protocol';

const source=readFileSync('db/migrations/3101_attendance_shared_workflow.sql','utf8');
const match=/CREATE OR REPLACE FUNCTION app\.attendance_workflow_links\(\) RETURNS trigger\s+LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS \$\$([\s\S]*?)\$\$;/.exec(source);
assert(match);const definition=match[0],body=match[1],union=body.replace('PERFORM pg_advisory_xact_lock(','PERFORM pg_advisory_xact_lock_shared(');
const bridge=readFileSync('db/migrations/3210_attendance_shared_workflow_submission_lock.sql','utf8');
const rollbackFault=Error('Controlled rollback before commit'),lostFault=Error('Controlled response loss after commit');
const driftFault=Error('Controlled native restoration guard refusals');
export type ProofResult=OwnerReport;

export async function runOwnerProof(input:OwnerInput,frontier:OwnerWorkFrontier,settleWork:()=>Promise<void>,stage:(name:string)=>Promise<void>,observe:(name:OwnerStage)=>void):Promise<ProofResult>{
 let currentStage:OwnerStage='admission';const enter=(name:OwnerStage)=>{currentStage=name;observe(name);};
 const result:ProofResult={kind:input.mode==='positive'?'ATTENDANCE_OWNER_POSITIVE':'ATTENDANCE_OWNER_FAULT',mode:input.mode,
  complete:false,allCatalogueRestored:false,roleAbsent:false,ownedOidCaptured:false,faultObserved:false,
  nonemptyApprover:false,canonicalRequestWritten:false,unchangedForcedRls:false};
 let count=0,stoppedPerson:string|undefined;
 const step:BridgeStep=action=>frontier.step(action);
 const fixtureStep:BridgeStep=async action=>{
  const value=await step(action);count++;
  if(input.mode==='stop-fixture'&&count===1){
   assert(value&&typeof value==='object'&&'personId'in value&&typeof value.personId==='string');stoppedPerson=value.personId;
   await stage('fixture-frontier');
  }
  return value;
 };
 let baseline:OwnerSnapshot|undefined,witness:OwnerSnapshot|undefined,targetDefinition:string|undefined;
 let workFailure:unknown,preexistingRole=false;
 try{
  const predecessor=await step(()=>bridgeSnapshot(owner.client,input.role));baseline=predecessor;
  if(predecessor.state.role){preexistingRole=true;throw Error('Unowned native role cannot be restored or dropped');}
  const [current]=await step(()=>owner.client<{definition:string;statementTimeout:string;lockTimeout:string}[]>`select pg_get_functiondef('app.attendance_workflow_links()'::regprocedure) as definition,current_setting('statement_timeout') as "statementTimeout",current_setting('lock_timeout') as "lockTimeout"`);
  assert.equal(current.statementTimeout,'5s');assert.equal(current.lockTimeout,'300ms');targetDefinition=current.definition;
  enter('fixture');const f=await attendanceBridgeFixture(input.base,fixtureStep);
  enter('forced-rls-before');
  const [forcedBefore]=await step(()=>owner.client<{rows:unknown}[]>`select jsonb_agg(jsonb_build_object('oid',oid,'owner',relowner,'rls',relrowsecurity,'force',relforcerowsecurity) order by oid) as rows from pg_class where relnamespace='public'::regnamespace and relforcerowsecurity`);
  assert(forcedBefore.rows);
  enter('access-catalogue');const access=await step(()=>owner.client<{name:string;rls:boolean;force:boolean}[]>`select relname as name,relrowsecurity as rls,relforcerowsecurity as force from pg_class where relnamespace='public'::regnamespace and relname in ('access_capability','access_configuration','access_group','access_group_grant','access_membership','access_user_override') order by relname`);
  // postgres Result extends Array; compare every ordered native row/fact without
  // requiring its transport container to have the plain-array prototype.
  assert.deepEqual(Array.from(access),['access_capability','access_configuration','access_group','access_group_grant','access_membership','access_user_override'].map(name=>({name,rls:true,force:true})));
  enter('ownership-create');await step(()=>owner.client.begin(async connection=>{
   frontier.check();
   await step(()=>connection.unsafe(guardedOwnerBatch(input.role,[
    `CREATE ROLE ${quoteBridgeRole(input.role)} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE INHERIT`,
    `GRANT ${quoteBridgeRole(predecessor.state.request.owner)} TO ${quoteBridgeRole(input.role)} WITH INHERIT TRUE, SET FALSE, ADMIN FALSE`,
    ...predecessor.state.functions.map(fn=>`ALTER FUNCTION ${fn.signature} OWNER TO ${quoteBridgeRole(input.role)}`),
    `ALTER TABLE public.attendance_workflow_request OWNER TO ${quoteBridgeRole(input.role)}`,definition,
   ])));
   // Captured before COMMIT. A lost commit response cannot erase the native OID.
   enter('owned-witness');witness=await step(()=>bridgeSnapshot(connection,input.role));
   assertCreatedRole(witness,predecessor.state.request.ownerOid);result.ownedOidCaptured=true;
   if(input.mode==='rollback-before-commit')throw rollbackFault;
  }));
  if(input.mode==='lost-after-commit')throw lostFault;
  if(input.mode==='restore-guard-drift'){
   enter('guard-drift');
   assert(witness&&baseline&&targetDefinition);
   const captured=witness,original=baseline,originalDefinition=targetDefinition;
   const commands=[`ALTER TABLE public.attendance_workflow_request OWNER TO ${quoteBridgeRole(original.state.request.owner)}`,
    ...original.state.functions.map(fn=>`ALTER FUNCTION ${fn.signature} OWNER TO ${quoteBridgeRole(fn.owner)}`),
    originalDefinition,`DROP ROLE ${quoteBridgeRole(input.role)}`];
   for(const mutation of [`ALTER ROLE ${quoteBridgeRole(input.role)} LOGIN`,
    `GRANT ${quoteBridgeRole(original.state.request.owner)} TO ${quoteBridgeRole(input.role)} WITH INHERIT TRUE, SET TRUE, ADMIN FALSE`]){
    let rolledBack=false;
    try{await step(()=>owner.client.begin(async connection=>{
     await step(()=>connection.unsafe(mutation));const changed=await step(()=>bridgeSnapshot(connection,input.role));
     assert.notDeepEqual(changed.state,captured.state);
     await step(()=>connection.unsafe('SAVEPOINT refused_restore'));
     let refused=false;
     try{await step(()=>connection.unsafe(guardedOwnerBatch(input.role,commands,captured,[body,union],original)));}
     catch(error){refused=error!==null&&typeof error==='object'&&'code'in error&&error.code==='55000';}
     await step(()=>connection.unsafe('ROLLBACK TO SAVEPOINT refused_restore'));
     assert(refused,'Changed native role/membership must refuse restoration before any DDL');
     assert.deepEqual(await step(()=>bridgeSnapshot(connection,input.role)),changed);
     throw rollbackFault;
    }));}catch(error){if(error!==rollbackFault)throw error;rolledBack=true;}
    assert(rolledBack);assert.deepEqual(await step(()=>bridgeSnapshot(owner.client,input.role)),captured);
   }
   throw driftFault;
  }
  enter('restricted-identity');await step(()=>owner.client.begin(async connection=>{
   await step(()=>connection.unsafe(`SET LOCAL ROLE ${quoteBridgeRole(input.role)}`));
   const [identity]=await step(()=>connection<{name:string;super:boolean;bypass:boolean;parentSet:boolean;statementTimeout:string;lockTimeout:string}[]>`select current_user as name,rolsuper as super,rolbypassrls as bypass,pg_has_role(current_user,${predecessor.state.request.owner},'SET') as "parentSet",current_setting('statement_timeout') as "statementTimeout",current_setting('lock_timeout') as "lockTimeout" from pg_roles where rolname=current_user`);
   assert.deepEqual(identity,{name:input.role,super:false,bypass:false,parentSet:false,statementTimeout:'5s',lockTimeout:'300ms'});result.restrictedIdentity=identity;
   enter('native-bridge');await step(()=>connection.unsafe(bridge));
   const [actual]=await step(()=>connection<{body:string}[]>`select prosrc as body from pg_proc where oid='app.attendance_workflow_links()'::regprocedure`);assert.equal(actual.body,union);
  }));
  enter('app-login');await step(()=>withTenant(f.root,async tx=>{
   const [identity]=await step(()=>tx.execute<{session:string;current:string;super:boolean;bypass:boolean}>(sql`select session_user as session,current_user as current,rolsuper as super,rolbypassrls as bypass from pg_roles where rolname=current_user`));
   assert.deepEqual(identity,{session:'ai_hr_app',current:'ai_hr_app',super:false,bypass:false});result.appIdentity=identity;
   enter('app-approvers');const candidates=await step(()=>tx.execute<{id:string}>(sql`select id from app.attendance_workflow_v3_approver_options(ARRAY[${input.base.companyId}::uuid,${f.other.id}::uuid])`));
   assert(candidates.some(row=>row.id===f.reviewer.employmentId));result.nonemptyApprover=true;
  }));
  enter('request-write');await step(()=>withTenant(f.worker.ctx,async tx=>{
   await step(()=>tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${f.key},0))`));
   await step(()=>tx.insert(s.attendanceWorkflowRequest).values(f.values(f.ids[0])));result.canonicalRequestWritten=true;
  }));
  enter('forced-rls-after');const [forcedAfter]=await step(()=>owner.client<{rows:unknown}[]>`select jsonb_agg(jsonb_build_object('oid',oid,'owner',relowner,'rls',relrowsecurity,'force',relforcerowsecurity) order by oid) as rows from pg_class where relnamespace='public'::regnamespace and relforcerowsecurity`);
  assert.deepEqual(forcedAfter,forcedBefore);result.unchangedForcedRls=true;
 }catch(error){workFailure=new OwnerRefusal(currentStage,preexistingRole);result.faultObserved=(input.mode==='rollback-before-commit'&&error===rollbackFault)||(input.mode==='lost-after-commit'&&error===lostFault)||(input.mode==='restore-guard-drift'&&error===driftFault)||(input.mode==='stop-fixture'&&frontier.isStopped());}
 finally{
  enter('work-settlement');await settleWork(); // All actual child work pools and startup constructors settle first.
  // Detected before any ownership command: touching this foreign role is never
  // cleanup. A normal caller still fails/poisons; a controlled collision fixture
  // has its own independently captured creator witness and separate teardown.
  if(!preexistingRole){
  enter('owned-restore');const restoreUrl=new URL(process.env.TEST_MIGRATION_DATABASE_URL!);
  restoreUrl.searchParams.set('application_name',restoreUrl.searchParams.get('application_name')+'_restore');
  const restore=postgres(restoreUrl.toString(),{max:1,connect_timeout:3});
  try{
   await restore.begin(async connection=>{
    if(witness){
     assert(baseline&&targetDefinition);
     await connection.unsafe(guardedOwnerBatch(input.role,[
       `ALTER TABLE public.attendance_workflow_request OWNER TO ${quoteBridgeRole(baseline.state.request.owner)}`,
       ...baseline.state.functions.map(fn=>`ALTER FUNCTION ${fn.signature} OWNER TO ${quoteBridgeRole(fn.owner)}`),
       targetDefinition,`DROP ROLE ${quoteBridgeRole(input.role)}`,
     ],witness,[body,union],baseline));
    }
    enter('final-audit');if(input.mode==='stop-fixture')assert(stoppedPerson,'Stopped canonical hire must have an independently identifiable subject');
    const [audit]=await connection.unsafe<{snapshot:OwnerSnapshot;newUsers:number}[]>(`select ${BRIDGE_SNAPSHOT} as snapshot,
      (select count(*)::integer from public.app_user where person_id=$2::uuid) as "newUsers"`,[input.role,stoppedPerson??null]);
    const after=audit.snapshot;assert.equal(audit.newUsers,0,'The next canonical createAppUser call must never have executed');
    if(!witness&&after.state.role)throw Error('Unowned native role cannot be restored or dropped');
    if(baseline)assert.deepEqual(after,baseline);
    assert.equal(after.state.role,null);result.roleAbsent=true;result.allCatalogueRestored=true;
   });
  }finally{await restore.end({timeout:1});}
  }
 }
 if(workFailure&&!result.faultObserved)throw workFailure;
 result.complete=true;return result;
}

export async function collisionControl(input:OwnerInput,frontier:OwnerWorkFrontier,settleWork:()=>Promise<void>,stage:(name:string)=>Promise<void>,observe:(name:OwnerStage)=>void):Promise<ProofResult>{
 observe('collision');
 const before=await frontier.step(()=>bridgeSnapshot(owner.client,input.role));assert.equal(before.state.role,null);
 let foreign:OwnerSnapshot|undefined,refused=false;
 try{
  await frontier.step(()=>owner.client.begin(async connection=>{
   await connection.unsafe(guardedOwnerBatch(input.role,[`CREATE ROLE ${quoteBridgeRole(input.role)} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE INHERIT`]));
   foreign=await bridgeSnapshot(connection,input.role);assert(foreign.state.role); // Fixture creator's OID, before its COMMIT.
  }));
  try{await runOwnerProof(input,frontier,settleWork,stage,observe);}catch(error){refused=error instanceof Error&&error.message==='Unowned native role cannot be restored or dropped';}
  assert(refused&&foreign,'The main owner must refuse the unowned role');
 }finally{
  await settleWork();
  const url=new URL(process.env.TEST_MIGRATION_DATABASE_URL!);url.searchParams.set('application_name',url.searchParams.get('application_name')+'_restore');
  const restore=postgres(url.toString(),{max:1,connect_timeout:3});
  try{
   await restore.begin(async connection=>{
    if(foreign){
     // Separate fixture-creator authority: exact native OID/full state, never
     // a name-only waiver for the main owner that just refused this role.
     await connection.unsafe(guardedOwnerBatch(input.role,[`DROP ROLE ${quoteBridgeRole(input.role)}`],foreign,[before.body],before));
    }
    assert.deepEqual(await bridgeSnapshot(connection,input.role),before);
   });
  }finally{await restore.end({timeout:1});}
 }
 assert(refused);
 return{kind:'ATTENDANCE_OWNER_FAULT',mode:input.mode,complete:true,allCatalogueRestored:true,roleAbsent:true,
  ownedOidCaptured:false,faultObserved:true,nonemptyApprover:false,canonicalRequestWritten:false,unchangedForcedRls:false};
}
