/** Parameter serialization only; this does not prove native authorization or execution. */
import {expect,it} from 'vitest';
import {PgDialect} from 'drizzle-orm/pg-core';
import {nativeEmployeeChoiceQuery} from './performance/employee-choice-native-purpose-reader';
const tenant='11111111-1111-1111-1111-111111111111',user='22222222-2222-2222-2222-222222222222';
const ctx={tenantId:tenant,userId:user,personId:null,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]};
function query(raw:string,offset=0,limit=25,scope:{companyIds:string[];employmentIds?:string[]}={companyIds:[]}){
 const prepared={filters:{query:raw,companyId:'',departmentId:'',businessUnitId:'',status:''},offset,limit,labelMode:'names' as const,q:raw.trim().toLowerCase()};
 return new PgDialect().sqlToQuery(nativeEmployeeChoiceQuery(ctx,scope,prepared,'page'));
}
it('never binds raw NUL or non-ASCII search text and retains distinct closed candidate modes',()=>{
 for(const raw of ['\0','name\0suffix','\u0130','\ud83d\ude00']){
  const actual=query(raw);expect(actual.params.some(value=>typeof value==='string'&&value.includes('\0'))).toBe(false);
  expect(actual.params[12]).toBe(raw.includes('\0')?'impossible':'unicode');expect(actual.params[13]).toBeNull();
 }
 expect(query('').params[12]).toBe('none');expect(query(' \t ').params[12]).toBe('none');
});
it('preserves literal LIKE metacharacters, ASCII controls and unbounded existing query length',()=>{
 expect(query('a%_\\b').params[13]).toBe('%a\\%\\_\\\\b%');
 for(const raw of ['\u0001name','\u007f','\tword\n','x'.repeat(20000)]){
  const actual=query(raw);expect(actual.params[12]).toBe('ascii');expect(actual.params[13]).toBe('%'+raw.trim().toLowerCase()+'%');
 }
});
it('preserves legacy empty company scope, explicit empty employee scope and safe large offset as typed parameters',()=>{
 const unspecified=query('');expect(unspecified.params[5]).toBe('{}');expect(unspecified.params[7]).toBeNull();
 const empty=query('',Number.MAX_SAFE_INTEGER,2000,{companyIds:[],employmentIds:[]});
 expect(empty.params[5]).toBe('{}');expect(empty.params[7]).toBe('{}');expect(empty.params[15]).toBe(Number.MAX_SAFE_INTEGER);expect(empty.params[16]).toBe(2000);
 expect(empty.sql).toContain('app.employee_choice_native_prototype(');expect(empty.params).toHaveLength(19);
});
