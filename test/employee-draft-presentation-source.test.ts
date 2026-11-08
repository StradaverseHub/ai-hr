/** Whole source reconstruction only. Native semantics are qualified separately. */
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
it('reconstructs the entire original Draft owner and every writer outside the one shared query and explicit presentation courses',()=>{
 const inverse=JSON.parse(readFileSync('docs/qualification/employee-draft-presentation-inverse-20261108.json','utf8'));
 expect(inverse.base).toBe('2ea980f2908afbd9ceac73fef3e6b5be5c6bef57');
 expect(inverse.file).toBe('core/employee-draft.ts');expect(inverse.parentSha256).toBe('8c5b61aea0ca026fd07043e9106918d65c946a08548444799f8bc24b82dd51db');
 const current=readFileSync(inverse.file,'utf8');expect(sha(current)).toBe(inverse.currentSha256);let restored=current;
 for(const change of [...inverse.changes].reverse()){
  expect(restored.split(change.after)).toHaveLength(2);restored=restored.replace(change.after,change.before);
 }
 expect(sha(restored)).toBe(inverse.parentSha256);
 const old=inverse.changes[1].before,prefix='export function getEmployeeDraft(ctx: SessionContext, id: string): Promise<EmployeeDraftDetail | null> {\n  return withTenant(ctx, async (tx) => {\n';
 const body=old.slice(prefix.length,-'  });\n}\n'.length);expect(old.startsWith(prefix)).toBe(true);expect(sha(body)).toBe(inverse.canonicalQueryBodySha256);
 const start=current.indexOf('async function readEmployeeDraftRowTx(tx:Tx,id:string):Promise<EmployeeDraftDetail|null>{\n')+'async function readEmployeeDraftRowTx(tx:Tx,id:string):Promise<EmployeeDraftDetail|null>{\n'.length;
 expect(current.slice(start,start+body.length)).toBe(body);expect(current.slice(start+body.length,start+body.length+2)).toBe('}\n');
 expect(inverse.applicationAdoption).toBe(false);expect(inverse.releaseAuthorized).toBe(false);
});
