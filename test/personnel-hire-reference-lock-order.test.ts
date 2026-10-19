import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';

/** An invariant across entry points: Criteria epochs must precede label tuple locks.
 * This source contract supplements, and does not establish, runtime concurrency safety. */
const source=(path:string)=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');
function functionBody(text:string,name:string){
 const start=text.indexOf(`function ${name}(`);expect(start,`${name} declaration`).toBeGreaterThanOrEqual(0);
 const end=text.indexOf('\nexport ',start+1);const body=text.slice(start,end<0?text.length:end);
 expect(body.length,`${name} body`).toBeGreaterThan(150);return body;
}
describe('hire/reference writer coordination order',()=>{
 // These legacy mutations once relied on a BEFORE ROW trigger, which is too late to
 // precede the UPDATE/DELETE tuple lock. Bulk save already acquired the owner explicitly.
 it.each(['updateDepartment','archiveDepartment','deleteDepartment','updatePosition','archivePosition','deletePosition','updateCostCenter','archiveCostCenter','deleteCostCenter','updateBusinessUnit','archiveBusinessUnit'])(
  '%s acquires the Criteria owner before its first mutation',name=>{
   const body=functionBody(source('core/admin.ts'),name);
   const coordination=body.indexOf('await lockLabelCriteriaTx(tx,ctx.tenantId)');
   const mutation=body.search(/await tx\.(?:update|delete)\(/);
   expect(coordination).toBeGreaterThanOrEqual(0);expect(mutation).toBeGreaterThan(coordination);
  });
 it('activation coordinates before the company/reference locks consumed by hire',()=>{
  const body=functionBody(source('core/employee-draft.ts'),'completeEmployeeDraftTx');
  const coordination=body.indexOf('await lockLabelCriteriaTx(tx,ctx.tenantId)');
  const company=body.indexOf('const [companyRow]');const reference=body.indexOf('const references=');const hire=body.indexOf('await hireEmployee(');
  expect(coordination).toBeGreaterThanOrEqual(0);expect(company).toBeGreaterThan(coordination);expect(reference).toBeGreaterThan(company);expect(hire).toBeGreaterThan(reference);
 });
 it('canonical hire coordinates before label locks and before inserting any person',()=>{
  const body=functionBody(source('core/org.ts'),'hireEmployee');
  const coordination=body.indexOf('await lockLabelCriteriaTx(tx,ctx.tenantId)');
  const share=body.indexOf(".for('share')");const person=body.indexOf('.insert(person)');
  expect(coordination).toBeGreaterThanOrEqual(0);expect(share).toBeGreaterThan(coordination);expect(person).toBeGreaterThan(share);
 });
});
