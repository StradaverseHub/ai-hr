/** Whole-stack review M15 (claude/teras-review-fixes): an HR administrator's harness turn may name the people they
 * administer, and nobody else. Owner privacy decision 9 ("Proceed but only based on the user's access"): the scope is
 * the database's own app.is_admin_for, read as the caller under RLS. Fictional fixtures (test/review/review-actors.ts). */
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {administeredEmployments} from '../core/harness/tools';
import {DisclosureLedger,discloseToolOutput} from '../core/harness/disclosure';
import {buildMatrix,type Matrix} from './review/review-actors';
import {closeAll,migrateTestDb,resetDb} from './harness';

const absences=(rows:readonly Readonly<{name:string;employmentId:string}>[])=>({ok:true,rows:rows.map(row=>({personName:row.name,employmentIds:[row.employmentId],
 absences:[{leaveType:'Annual Leave',status:'pending',startDate:'2026-11-09',endDate:'2026-11-09',days:1}]}))});

describe('M15: names an HR administrator may see through the harness (pure disclosure)',()=>{
 const inScope=randomUUID(),outOfScope=randomUUID();
 it('keeps the name of a person in the administered scope and withholds everyone else\'s',()=>{
  const ledger=new DisclosureLedger('caller'),output=absences([{name:'Fictional Siti In Scope',employmentId:inScope},{name:'Fictional Ravi Out Of Scope',employmentId:outOfScope}]);
  const {value,applied}=discloseToolOutput('who_is_away','absence',output,ledger,{namesInScope:new Set([inScope])});
  const sent=JSON.stringify(value);
  expect(sent).toContain('Fictional Siti In Scope');expect(sent).not.toContain('Fictional Ravi Out Of Scope');
  // The in-scope person's other minimum fields (dates) still leave as placeholders; employment ids as handles.
  expect(sent).not.toContain('2026-11-09');expect(sent).not.toContain(inScope);expect(applied.withheld.length).toBeGreaterThan(0);
 });
 it('withholds every name without a scope (the default for every caller who is not an administrator)',()=>{
  const ledger=new DisclosureLedger('caller');
  const sent=JSON.stringify(discloseToolOutput('who_is_away','absence',absences([{name:'Fictional Siti In Scope',employmentId:inScope}]),ledger).value);
  expect(sent).not.toContain('Fictional Siti In Scope');
 });
 it('withholds a row that also carries an employment outside the scope',()=>{
  const ledger=new DisclosureLedger('caller'),output={ok:true,rows:[{personName:'Fictional Two Employments',employmentIds:[inScope,outOfScope]}]};
  expect(JSON.stringify(discloseToolOutput('who_is_away','absence',output,ledger,{namesInScope:new Set([inScope])}).value)).not.toContain('Fictional Two Employments');
 });
});

let m:Matrix;
describe('M15: the administered scope is the database\'s, read as the caller',()=>{
 beforeAll(migrateTestDb);afterAll(closeAll);
 beforeEach(async()=>{await resetDb();m=await buildMatrix();});
 const content=()=>absences([{name:m.employee.name,employmentId:m.employee.employmentId},{name:m.otherCompanyAdmin.name,employmentId:m.otherCompanyAdmin.employmentId}]);
 it('a company-scoped HR administrator administers their own company\'s people, not another company\'s',async()=>{
  const scope=await administeredEmployments(m.companyAdmin.ctx,content());
  expect(scope.has(m.employee.employmentId)).toBe(true);expect(scope.has(m.otherCompanyAdmin.employmentId)).toBe(false);
 });
 it('another company\'s administrator administers only their own company',async()=>{
  const scope=await administeredEmployments(m.otherCompanyAdmin.ctx,content());
  expect(scope.has(m.otherCompanyAdmin.employmentId)).toBe(true);expect(scope.has(m.employee.employmentId)).toBe(false);
 });
 it('a group administrator administers both companies',async()=>{
  const scope=await administeredEmployments(m.groupAdmin.ctx,content());
  expect([...scope].sort()).toEqual([m.employee.employmentId,m.otherCompanyAdmin.employmentId].sort());
 });
 it('a manager, a payroll partner and an employee administer nobody, so every name stays a placeholder',async()=>{
  for(const actor of [m.manager,m.payroll,m.employee])expect((await administeredEmployments(actor.ctx,content())).size,actor.name).toBe(0);
 });
 it('another tenant\'s administrator administers nobody here',async()=>{
  expect((await administeredEmployments(m.otherTenant.ctx,content())).size).toBe(0);
 });
});

describe('M16: the destination registry says My Payslip is the person\'s own payslips, never a payroll run',()=>{
 it('gives /me/payslip a purpose the model sees beside its label',async()=>{
  const {DESTINATION_PURPOSE}=await import('../lib/product-context/destinations');
  expect(DESTINATION_PURPOSE['/me/payslip']).toMatch(/own released payslips only/);expect(DESTINATION_PURPOSE['/me/payslip']).toMatch(/never a payroll run/i);
 });
});
