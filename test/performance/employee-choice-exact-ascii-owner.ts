/** Guarded composition in the original disposable DB; no new role, grant or ABI. */
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {expect} from 'vitest';
import {z} from 'zod';
import {owner} from '../harness';
import {employeeChoiceNativeSecurity,employeeChoicePrototypeSignature,installEmployeeChoiceNativePrototype} from './employee-choice-native-purpose-owner';
import {preserveDiagnosticFailure} from './employee-choice-native-purpose-session';
const row=z.object({definition:z.string(),identity:z.record(z.string(),z.unknown())}).strict();
type Definition=z.infer<typeof row>;
const sourceFile='test/fixtures/employee-choice-exact-ascii-purpose.sql';
const sourceSha256='10b0d44d8943fdfbb76e748028e8fbd2938a514ea22c57b70cfcc665b6a41743';
async function definition():Promise<Definition>{return row.parse((await owner.client`select pg_get_functiondef(p.oid)as definition,to_jsonb(p)as identity from pg_proc p where p.oid=${employeeChoicePrototypeSignature}::regprocedure`)[0]);}
const exceptBody=(value:Definition['identity'])=>Object.fromEntries(Object.entries(value).filter(([key])=>key!=='prosrc'));
export async function installExactAsciiEmployeeChoicePrototype(){
 const source=readFileSync(sourceFile,'utf8');expect(createHash('sha256').update(source).digest('hex')).toBe(sourceSha256);
 const bodies=source.split('$employee_choice$');expect(bodies).toHaveLength(3);const body=bodies[1];expect(body.length).toBeGreaterThan(10000);
 const original=await installEmployeeChoiceNativePrototype(),before=row.parse({definition:original.installed.definition,identity:original.installed.identity});
 expect(before.identity.prosrc).not.toBe(body);let candidate:Definition|undefined,removed=false;
 // Exact intent is bound to the original actual native OID/metadata BEFORE the
 // additive transaction can COMMIT. Ambiguity never authorizes guessed cleanup.
 async function restore(){
  const current=await definition();expect(exceptBody(current.identity)).toEqual(exceptBody(before.identity));
  if(current.identity.prosrc===before.identity.prosrc)expect(current).toEqual(before);
  else{
   expect(current.identity.prosrc).toBe(body);if(candidate)expect(current).toEqual(candidate);
   await owner.client.begin(async tx=>{await tx`set local statement_timeout='20s'`;await tx`set local lock_timeout='300ms'`;
    const actual=row.parse((await tx`select pg_get_functiondef(p.oid)as definition,to_jsonb(p)as identity from pg_proc p where p.oid=${employeeChoicePrototypeSignature}::regprocedure`)[0]);expect(actual).toEqual(current);
    await tx.unsafe(before.definition);
   });expect(await definition()).toEqual(before);
  }
  await original.unchanged();
 }
 try{
  await original.unchanged();
  candidate=await owner.client.begin(async tx=>{
   await tx`set local statement_timeout='20s'`;await tx`set local lock_timeout='300ms'`;
   expect(row.parse((await tx`select pg_get_functiondef(p.oid)as definition,to_jsonb(p)as identity from pg_proc p where p.oid=${employeeChoicePrototypeSignature}::regprocedure`)[0])).toEqual(before);
   await tx`select set_config('aihr.employee_choice_probe.database',${original.database},true)`;await tx.unsafe(source);
   const actual=row.parse((await tx`select pg_get_functiondef(p.oid)as definition,to_jsonb(p)as identity from pg_proc p where p.oid=${employeeChoicePrototypeSignature}::regprocedure`)[0]);
   expect(actual.identity.prosrc).toBe(body);expect(exceptBody(actual.identity)).toEqual(exceptBody(before.identity));
   return actual;
  });
  expect(await employeeChoiceNativeSecurity()).toEqual(original.security);
 }catch(error){await preserveDiagnosticFailure(async()=>{throw error;},async()=>{await restore();await original.remove();});throw error;}
 const installed=candidate;if(!installed)throw Error('Exact ASCII candidate identity unavailable');
 async function unchanged(){if(removed)throw Error('No owned exact ASCII installation');expect(await definition()).toEqual(installed);expect(await employeeChoiceNativeSecurity()).toEqual(original.security);}
 return{database:original.database,sourceSha256,originalSourceSha256:original.sourceSha256,installed,security:original.security,
  unchanged,
  async remove(){if(removed)return;await restore();await original.remove();removed=true;},
 };
}
