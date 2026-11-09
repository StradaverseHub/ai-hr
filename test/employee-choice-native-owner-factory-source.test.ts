/** Pure exact-byte preservation only, not a native SQL/result/resource witness. */
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {employeeChoiceNativeOwnerInverse} from './performance/employee-choice-native-owner-source';
import {employeeChoiceRestorationSourceInverse} from './performance/employee-choice-restoration-source';
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const baseline=readFileSync('test/fixtures/employee-choice-native-purpose-owner-334.source','utf8'),factory=readFileSync('test/performance/employee-choice-native-purpose-owner-factory.ts','utf8');
it('reconstructs the COMPLETE exact334 original from the factory with only explicit carrier/borrowed-tx routing inverted',()=>{
 expect(sha(baseline)).toBe('3df8e3b01b4ab52304675b8d167f68059ac8e47cfa12835c0b3c3db034da4d3d');
 expect(employeeChoiceNativeOwnerInverse(employeeChoiceRestorationSourceInverse('test/performance/employee-choice-native-purpose-owner-factory.ts',factory))).toBe(baseline);
});
it('cannot normalize away any changed native owner/ACL/metadata guard or full security snapshot',()=>{
 for(const [before,after]of [['public:false','public:true'],["prosecdef:false","prosecdef:true"],["expect(current).toEqual({definition:installed.definition,identity:installed.identity});","expect(true).toBe(true);"],["select * from pg_auth_members order by roleid,member","select roleid from pg_auth_members"]]){
  expect(factory).toContain(before);expect(()=>employeeChoiceRestorationSourceInverse('test/performance/employee-choice-native-purpose-owner-factory.ts',factory.replace(before,after))).toThrow();
  const original=employeeChoiceRestorationSourceInverse('test/performance/employee-choice-native-purpose-owner-factory.ts',factory);expect(sha(employeeChoiceNativeOwnerInverse(original.replace(before,after)))).not.toBe(sha(baseline));
 }
 const original=employeeChoiceRestorationSourceInverse('test/performance/employee-choice-native-purpose-owner-factory.ts',factory);expect(()=>employeeChoiceNativeOwnerInverse(original.replace('async function readNativeSecurity(query:ISql){','async function foreign(){'))).toThrow('boundary');
});
it('keeps the public wrapper as an exact dynamic default binding with unchanged names and optional preCOMMIT adoption',()=>{
 expect(readFileSync('test/performance/employee-choice-native-purpose-owner.ts','utf8')).toBe(`/** Legacy dynamic harness binding. Pool/defaults and public API are unchanged. */
import {owner} from '../harness';
import {employeeChoiceNativePrototypeOwner,type EmployeeChoiceNativeInstallation} from './employee-choice-native-purpose-owner-factory';
export {employeeChoicePrototypeSignature,employeeChoicePrototypeSqlSha256} from './employee-choice-native-purpose-owner-factory';
export type {EmployeeChoiceNativeInstallation} from './employee-choice-native-purpose-owner-factory';
const legacy=employeeChoiceNativePrototypeOwner(()=>owner.client);
export async function employeeChoiceNativeSecurity(){return legacy.security();}
export async function installEmployeeChoiceNativePrototype(adopt?:(value:EmployeeChoiceNativeInstallation)=>void):Promise<EmployeeChoiceNativeInstallation>{return legacy.install(adopt);}
`);
});

function restoreHistoricalReader(bytes:Buffer){
 if(createHash('sha256').update(bytes).digest('hex')!=='fc1a1603aa7a032a0450dfca98eddd6068de5a1913478d25e5e7e90eea8e3816')
  throw Error('Frozen relocated reader differs');
 const source=bytes.toString('utf8');
 const end=source.indexOf('\n\n');
 const [comment,...imports]=source.slice(0,end).split('\n');
 expect(comment).toBe('/** Exact current-root f151 reader; frozen test-only comparison, never a production owner. */');
 expect(imports).toHaveLength(10);
 const relocations=[
  ['../../db/client','../db/client'],
  ['../../db/schema','../db/schema'],
  ['../../core/ai-principal','./ai-principal'],
  ['../../lib/organisation-choice-label','../lib/organisation-choice-label'],
  ['../../lib/authz-model','../lib/authz-model'],
  ['../../lib/calendar-date','../lib/calendar-date'],
  ['../../lib/pagination','../lib/pagination'],
  ['../../lib/employee-choice','../lib/employee-choice'],
 ] as const;
 for(const [index,[relocated,original]] of relocations.entries()){
  const suffix="'"+relocated+"';",line=imports[index+2];
  expect(line.endsWith(suffix)).toBe(true);
  imports[index+2]=line.slice(0,-suffix.length)+"'"+original+"';";
 }
 return imports.join('\n')+source.slice(end);
}
it('reconstructs the whole historical f151 reader from the separately frozen comparison bytes',()=>{
 const bytes=readFileSync('test/performance/employee-choice-native-current-baseline.ts'),source=bytes.toString('utf8');
 expect(sha(restoreHistoricalReader(bytes))).toBe('ce1e3559addbffa4b4e780594ebcc5fcf917ddffde79a6155cc7fbcecdbcfbd5');
 expect(()=>restoreHistoricalReader(Buffer.from(source.replace("from '../../db/client'","from '../../db/schema'")))).toThrow('Frozen relocated reader differs');
 expect(()=>restoreHistoricalReader(Buffer.from(source.replace('EmployeeChoiceInputError extends Error','EmployeeChoiceInputError extends TypeError')))).toThrow('Frozen relocated reader differs');
});
