/** Owned-database, plan-phase-only logging. This grants no application capability. */
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {expect} from 'vitest';
import {owner} from '../harness';
import {employeeLoggingNativeRow,employeeRestorationHash,verifyEmployeeLoggingRestoration,employeePlanLoggingChanges,employeeRestorationIdentity} from '../../.github/ci/employee-restoration-proof.mjs';
const changes=employeePlanLoggingChanges;
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const literal=(value:string)=>"'"+value.replace(/'/g,"''")+"'";
type NativeSettings={setdatabase:unknown;setrole:unknown;setconfig:string[]}|null;
async function settings(client:Pick<typeof owner.client,'unsafe'>=owner.client):Promise<NativeSettings>{
 const [row]=await client.unsafe<{config:unknown}[]>("select (select to_jsonb(s) from pg_db_role_setting s where s.setdatabase=(select oid from pg_database where datname=current_database()) and s.setrole=0) as config");
 if(!row)throw Error('Native database settings row required');return employeeLoggingNativeRow(row.config) as NativeSettings;
}
const values=(row:NativeSettings)=>row===null?[]:row.setconfig;
export type EmployeeChoicePlanLogging={settings:typeof changes;beforeSha256:string;instrumentedSha256:string;restore:()=>Promise<void>;restoration:()=>Promise<unknown>};
export async function employeeChoicePlanLogging(database:string,adopt?:(value:EmployeeChoicePlanLogging)=>void){
 expect(database).toMatch(/^ai_hr_test_w(?:_[a-z0-9_]{1,20})?[1-9][0-9]*$/);
 const nativeIdentity=async()=>{const [identity]=await owner.client`select current_user as role,session_user as login,current_database() as database,(select oid::text from pg_database where datname=current_database())as "databaseOid",inet_server_addr()='127.0.0.1'::inet as loopback`;employeeRestorationIdentity(identity,database);return identity;};
 await nativeIdentity();
 const beforeRow=await settings(),before=values(beforeRow),previous=new Map(before.map(value=>{const index=value.indexOf('=');return[value.slice(0,index),value.slice(index+1)];}));
 // Canonical ALTER DATABASE RESET removes its last logical row. Never collapse
 // an unexplained manually-created empty predecessor into native row absence.
 if(beforeRow!==null&&before.length===0)throw Error('Existing empty native settings row cannot be restored by canonical instrumentation');
 expect(previous.get('session_preload_libraries')??'').toBe('');
 const expected=[...before];
 for(const [key,value]of Object.entries(changes)){
  const index=expected.findIndex(entry=>entry.startsWith(key+'='));if(index<0)expected.push(key+'='+value);else expected[index]=key+'='+value;
 }
 let restored=false,instrumented:NativeSettings|undefined;
 const restoration=async()=>{
  if(instrumented===undefined)throw Error('Native logging postimage was not adopted');
  const identity=await nativeIdentity(),after=await settings();
  const value={version:1,kind:'NATIVE_EMPLOYEE_LOGGING_RESTORATION_NOT_RELEASE',database,identity,before:structuredClone(beforeRow),instrumented:structuredClone(instrumented),after,beforeSha256:hash(before),instrumentedSha256:hash(expected),beforeNativeSha256:employeeRestorationHash(beforeRow),instrumentedNativeSha256:employeeRestorationHash(instrumented),afterNativeSha256:employeeRestorationHash(after)};
  return verifyEmployeeLoggingRestoration(value,{database,beforeSha256:hash(before),instrumentedSha256:hash(expected)});
 };
 const resource:EmployeeChoicePlanLogging={settings:changes,beforeSha256:hash(before),instrumentedSha256:hash(expected),
  async restore(){
   if(restored){await restoration();return;}
   await owner.client.begin(async tx=>{
    const observed=await settings(tx);
    if(isDeepStrictEqual(observed,beforeRow))return; // Exact rolled-back predecessor, including row absence.
    if(instrumented===undefined)throw Error('Native logging postimage was not adopted');
    expect(observed).toEqual(instrumented); // Refuse unknown/concurrent changes; never RESET ALL.
    for(const key of Object.keys(changes).reverse()){
     const prior=previous.get(key);
     await tx.unsafe('alter database "'+database+'" '+(prior===undefined?'reset "'+key+'"':'set "'+key+'" to '+literal(prior)));
    }
    expect(await settings(tx)).toEqual(beforeRow);
   });
   await restoration();restored=true; // Fresh native observation AFTER COMMIT, before the success latch.
  },
  async restoration(){if(!restored)throw Error('Native logging restoration has not settled');return restoration();}};
 await owner.client.begin(async tx=>{
  expect(await settings(tx)).toEqual(beforeRow);
  for(const [key,value]of Object.entries(changes))await tx.unsafe('alter database "'+database+'" set "'+key+'" to '+literal(value));
  const after=await settings(tx);expect(values(after)).toEqual(expected);if(after===null)throw Error('Instrumented native row absent');instrumented=structuredClone(after);
  adopt?.(resource); // Exact full native before/postimage owned before COMMIT response.
 });
 return resource;
}
