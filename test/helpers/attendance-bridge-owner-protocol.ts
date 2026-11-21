/** Test-only process protocol. No DB, app import, process creation or authority from input. */
import assert from 'node:assert/strict';
import {dirname} from 'node:path';
import type {Base} from '../harness';

export const OWNER_MODES=['positive','rollback-before-commit','lost-after-commit','stop-late-pool','stop-fixture','role-collision','restore-guard-drift'] as const;
export type OwnerMode=typeof OWNER_MODES[number];
export const OWNER_STAGES=['admission','fixture','forced-rls-before','access-catalogue','ownership-create','owned-witness','guard-drift','restricted-identity','native-bridge','app-login','app-approvers','request-write','forced-rls-after','work-settlement','owned-restore','final-audit','late-pools','collision']as const;
export type OwnerStage=typeof OWNER_STAGES[number];
export class OwnerRefusal extends Error{constructor(readonly stage:OwnerStage,foreignRole=false){super(foreignRole?'Unowned native role cannot be restored or dropped':'Closed owned Attendance proof refused');}}
export function ownerStage(value:unknown):OwnerStage{assert(typeof value==='string'&&OWNER_STAGES.includes(value as OwnerStage),'Unknown closed owner stage');return value as OwnerStage;}
export type OwnerInput={version:1;kind:'OWNED_ATTENDANCE_BRIDGE_COMPONENT';base:Base;role:string;mode:OwnerMode};
export type OwnerReport={kind:'ATTENDANCE_OWNER_POSITIVE'|'ATTENDANCE_OWNER_FAULT';mode:OwnerMode;
 complete:boolean;allCatalogueRestored:boolean;roleAbsent:boolean;ownedOidCaptured:boolean;faultObserved:boolean;
 restrictedIdentity?:{name:string;super:boolean;bypass:boolean;parentSet:boolean;statementTimeout:string;lockTimeout:string};
 appIdentity?:{session:string;current:string;super:boolean;bypass:boolean};nonemptyApprover:boolean;canonicalRequestWritten:boolean;unchangedForcedRls:boolean};
export function ownerReport(value:unknown):OwnerReport{
 assert(value&&typeof value==='object');const report=value as OwnerReport;
 const keys=['kind','mode','complete','allCatalogueRestored','roleAbsent','ownedOidCaptured','faultObserved','nonemptyApprover','canonicalRequestWritten','unchangedForcedRls'];
 if(report.appIdentity!==undefined){keys.push('appIdentity');assert.deepEqual(report.appIdentity,{session:'ai_hr_app',current:'ai_hr_app',super:false,bypass:false});}
 if(report.restrictedIdentity!==undefined){keys.push('restrictedIdentity');const identity=report.restrictedIdentity;
  assert(/^bridge_owner_[a-f0-9]{32}$/.test(identity.name));assert.deepEqual(identity,{name:identity.name,super:false,bypass:false,parentSet:false,statementTimeout:'5s',lockTimeout:'300ms'});
 }
 assert.deepEqual(Object.keys(report).sort(),keys.sort());assert(OWNER_MODES.includes(report.mode));
 assert.equal(report.kind,report.mode==='positive'?'ATTENDANCE_OWNER_POSITIVE':'ATTENDANCE_OWNER_FAULT');
 for(const key of ['complete','allCatalogueRestored','roleAbsent','ownedOidCaptured','faultObserved','nonemptyApprover','canonicalRequestWritten','unchangedForcedRls']as const)assert.equal(typeof report[key],'boolean');
 return report;
}
export function ownerInput(value:unknown):OwnerInput{
 assert(value&&typeof value==='object');const input=value as OwnerInput;
 assert.deepEqual(Object.keys(input).sort(),['base','kind','mode','role','version']);
 assert.equal(input.version,1);assert.equal(input.kind,'OWNED_ATTENDANCE_BRIDGE_COMPONENT');
 assert(OWNER_MODES.includes(input.mode));assert(/^bridge_owner_[a-f0-9]{32}$/.test(input.role));
 assert.deepEqual(Object.keys(input.base).sort(),['adminUserId','annualLeaveTypeId','companyId','costCenterId','deptA','deptB','positionId','tenantId']);
 for(const value of Object.values(input.base))assert(typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value));
 return input;
}
export function ownedDatabaseUrls(appValue:string,ownerValue:string,workerDatabase:string,tag:string){
 try{return checkedDatabaseUrls(appValue,ownerValue,workerDatabase,tag);}catch{throw Error('Closed owned Attendance database capability required');}
}
function checkedDatabaseUrls(appValue:string,ownerValue:string,workerDatabase:string,tag:string){
 assert(/^ai_hr_test_w[a-z0-9_]*[0-9]+$/.test(workerDatabase));assert(/^bridge_[a-f0-9]{32}$/.test(tag));
 const app=new URL(appValue),owner=new URL(ownerValue);
 for(const [value,user]of [[app,'ai_hr_app'],[owner,'postgres']]as const){
  assert(['postgres:','postgresql:'].includes(value.protocol));assert(['localhost','127.0.0.1','[::1]'].includes(value.hostname));
  assert.equal(decodeURIComponent(value.pathname),'/' + workerDatabase);assert.equal(decodeURIComponent(value.username),user);
  assert.equal(value.hash,'');for(const key of value.searchParams.keys())assert.equal(key,'sslmode');
  if(value.searchParams.has('sslmode'))assert.equal(value.searchParams.get('sslmode'),'disable');
  value.searchParams.set('connect_timeout','3');value.searchParams.set('options','-c statement_timeout=5000 -c lock_timeout=300');
  value.searchParams.set('application_name',tag);
 }
 assert.equal(app.hostname,owner.hostname);assert.equal(app.port||'5432',owner.port||'5432');
 return{app:app.toString(),owner:owner.toString()};
}
export function childEnvironment(env:NodeJS.ProcessEnv,urls:{app:string;owner:string},executable:string){
 const result:NodeJS.ProcessEnv={PATH:dirname(executable)+':/usr/bin:/bin',HOME:'/var/empty/aihr-attendance-test',LANG:'C.UTF-8',LC_ALL:'C.UTF-8',TZ:'Asia/Kuala_Lumpur',NODE_ENV:'test',
  DATABASE_URL:urls.app,TEST_DATABASE_URL:urls.app,MIGRATION_DATABASE_URL:urls.owner,TEST_MIGRATION_DATABASE_URL:urls.owner,WORKER_DB:'0'};
 if(env.CI==='true')result.CI='true';
 return result;
}
type OwnedPool={end:(options:{timeout:number})=>PromiseLike<void>};
export class OwnerWorkFrontier{
 private stopped=false;
 private readonly pools=new Map<OwnedPool,Promise<void>|undefined>();
 private readonly starting=new Set<Promise<void>>();
 private close(pool:OwnedPool){if(!this.pools.get(pool)){
  let closing:Promise<void>;try{closing=Promise.resolve(pool.end({timeout:1}));}catch(error){closing=Promise.reject(error);}
  void closing.catch(()=>undefined);this.pools.set(pool,closing);
 }}
 adopt<T extends OwnedPool>(pool:T):T{if(!this.pools.has(pool))this.pools.set(pool,undefined);if(this.stopped)this.close(pool);return pool;}
 construct<T>(factory:()=>Promise<T>,resources:(value:T)=>OwnedPool[]):Promise<T>{
  this.check();
  const result=Promise.resolve().then(factory).then(value=>{for(const pool of resources(value))this.adopt(pool);this.check();return value;});
  const settled=result.then(()=>undefined,()=>undefined);this.starting.add(settled);
  void settled.then(()=>this.starting.delete(settled));
  return result;
 }
 stop(){this.stopped=true;for(const pool of this.pools.keys())this.close(pool);}
 check(){assert(!this.stopped,'Owned Attendance work stopped');}
 isStopped(){return this.stopped;}
 async step<T>(action:()=>PromiseLike<T>):Promise<T>{this.check();return action();}
 async closeAll(){this.stop();await Promise.all([...this.starting]);let size:number;do{size=this.pools.size;await Promise.all([...this.pools.values()]);}while(size!==this.pools.size);}
}
