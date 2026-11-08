/** Fixed native composition. No pool, harness binding, actor or authority cache. */
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {expect} from 'vitest';
import {z} from 'zod';
import {sql} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import {employeeChoiceAsciiObservation} from '../../core/employee-choice-ascii';
import type {ISql,Sql} from 'postgres';
import {employeeChoiceNativePrototypeOwner,employeeChoicePrototypeSignature,type EmployeeChoiceNativeInstallation} from './employee-choice-native-purpose-owner-factory';
const row=z.object({definition:z.string(),identity:z.record(z.string(),z.unknown())}).strict();
type Definition=z.infer<typeof row>;
const sourceFile='test/fixtures/employee-choice-exact-ascii-purpose.sql';
const sourceSha256='10b0d44d8943fdfbb76e748028e8fbd2938a514ea22c57b70cfcc665b6a41743';
const templateSha256='e1468e77942f4f2dc557d729be7eb42683d844bc92288e127fd2b6a095ad6b92';
/** One fixed renderer for installation and the native plan harness. The protected
 * consumer independently reconstructs these reviewed bytes; this is no issuer. */
export function exactAsciiEmployeeChoiceSource():string{
 const template=readFileSync(sourceFile,'utf8');expect(createHash('sha256').update(template).digest('hex')).toBe(templateSha256);
 let source=template;
 for(const [marker,field] of [['/* EMPLOYEE_CHOICE_ASCII_NAME */','p.name'],['/* EMPLOYEE_CHOICE_ASCII_CODE */','coalesce(p."employeeCode",\'\')']] as const){
  expect(source.split(marker)).toHaveLength(2);
  const rendered=new PgDialect().sqlToQuery(employeeChoiceAsciiObservation(sql.raw(field)));expect(rendered.params).toEqual([]);
  source=source.replace(marker,rendered.sql);
 }
 // Every installed byte must still equal the reviewed original prototype SQL.
 expect(createHash('sha256').update(source).digest('hex')).toBe(sourceSha256);
 return source;
}
async function definition(query:ISql):Promise<Definition>{return row.parse((await query`select pg_get_functiondef(p.oid)as definition,to_jsonb(p)as identity from pg_proc p where p.oid=${employeeChoicePrototypeSignature}::regprocedure`)[0]);}
const exceptBody=(value:Definition['identity'])=>Object.fromEntries(Object.entries(value).filter(([key])=>key!=='prosrc'));
export type ExactAsciiNativeWitness=Readonly<{database:string;sourceSha256:string;templateSha256:string;originalSourceSha256:string;original:Definition;candidate:Definition|null;security:EmployeeChoiceNativeInstallation['security']}>;
export type ExactAsciiOwnership=Readonly<{remove:()=>Promise<void>;witness:()=>ExactAsciiNativeWitness}>;
export type ExactAsciiAdoption=(value:ExactAsciiOwnership,phase:'original'|'candidate')=>void;
export function exactAsciiEmployeeChoiceOwner(getQuery:()=>Sql,getPhase:()=> 'work'|'cleanup'){
 const native=employeeChoiceNativePrototypeOwner(getQuery);
 async function budget(tx:ISql){
  // Legacy/default work is unchanged20s. A real cleanup carrier never has its
  // existing1s limit raised by the original compositional SET LOCAL20s.
  const phase=getPhase();if(phase==='cleanup')await tx`set local statement_timeout='1s'`;else if(phase==='work')await tx`set local statement_timeout='20s'`;else throw Error('Closed native composition phase required');
  await tx`set local lock_timeout='300ms'`;
 }
 async function install(adopt:ExactAsciiAdoption){
  const source=exactAsciiEmployeeChoiceSource();
  const bodies=source.split('$employee_choice$');expect(bodies).toHaveLength(3);const body=bodies[1];expect(body.length).toBeGreaterThan(10000);
  const state:{original?:EmployeeChoiceNativeInstallation;before?:Definition;candidate?:Definition}={};let removed=false;
  const originalWitness=()=>{const {original,before}=state;if(!original||!before)throw Error('Complete original native witness absent');return{original,before};};
  async function restore(){
   const {original,before}=originalWitness();
   const current=await definition(getQuery());expect(exceptBody(current.identity)).toEqual(exceptBody(before.identity));
   if(current.identity.prosrc===before.identity.prosrc)expect(current).toEqual(before);
   else{
    const candidate=state.candidate;if(!candidate)throw Error('Complete candidate native witness absent; restoration refused');expect(current).toEqual(candidate);
    await getQuery().begin(async tx=>{await budget(tx);
     const actual=await definition(tx);expect(actual).toEqual(current);
     await tx.unsafe(before.definition);expect(await definition(tx)).toEqual(before);
    });expect(await definition(getQuery())).toEqual(before);
   }
   await original.unchanged();
  }
  const custody:ExactAsciiOwnership=Object.freeze({
   witness(){const {original,before}=originalWitness();return structuredClone({database:original.database,sourceSha256,templateSha256,originalSourceSha256:original.sourceSha256,original:before,candidate:state.candidate??null,security:original.security});},
   async remove(){
   if(removed){await originalWitness().original.remove();return;}const {original}=originalWitness();
   const [present]=await getQuery()`select count(*)::int as count from pg_proc where pronamespace='app'::regnamespace and proname='employee_choice_native_prototype'`;
   if(present.count===0){await original.remove();removed=true;return;}
   expect(present.count).toBe(1);await restore();await original.remove();removed=true;
  }});
  // Same cleanup capability is owned BEFORE BOTH possible native COMMITs.
  // Errors defer cleanup to that owner; never restore through stopped work SQL.
  await native.install(value=>{
   if(state.original)throw Error('Duplicate original native witness refused');state.original=value;state.before=row.parse({definition:value.installed.definition,identity:value.installed.identity});
   expect(state.before.identity.prosrc).not.toBe(body);adopt(custody,'original');
  });
  const {original:nativeOriginal,before:prior}=originalWitness();await nativeOriginal.unchanged();
  await getQuery().begin(async tx=>{
   await budget(tx);expect(await definition(tx)).toEqual(prior);
   await tx`select set_config('aihr.employee_choice_probe.database',${nativeOriginal.database},true)`;await tx.unsafe(source);
   const actual=await definition(tx);expect(actual.identity.prosrc).toBe(body);expect(exceptBody(actual.identity)).toEqual(exceptBody(prior.identity));
   if(state.candidate)throw Error('Duplicate candidate native witness refused');state.candidate=actual;adopt(custody,'candidate'); // actual full native result BEFORE COMMIT
  });
  expect(await native.security()).toEqual(nativeOriginal.security);
  const installed=state.candidate;if(!installed)throw Error('Exact ASCII candidate identity unavailable');
  async function unchanged(){if(removed)throw Error('No owned exact ASCII installation');expect(await definition(getQuery())).toEqual(installed);expect(await native.security()).toEqual(nativeOriginal.security);}
  return{database:nativeOriginal.database,sourceSha256,templateSha256,originalSourceSha256:nativeOriginal.sourceSha256,installed:structuredClone(installed),security:structuredClone(nativeOriginal.security),unchanged,remove:custody.remove,restoration:()=>originalWitness().original.restoration()};
 }
 return{install};
}
export type ExactAsciiInstallation=Awaited<ReturnType<ReturnType<typeof exactAsciiEmployeeChoiceOwner>['install']>>;
