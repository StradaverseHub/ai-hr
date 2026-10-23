import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import ts from 'typescript';
import {describe,expect,it} from 'vitest';
const core=readFileSync(resolve(__dirname,'../core/toil.ts'),'utf8');
const adapter=readFileSync(resolve(__dirname,'../packs/attendance/overtime-toil.ts'),'utf8');
function adapterFunction(name:string){
 const source=ts.createSourceFile('overtime-toil.ts',adapter,ts.ScriptTarget.Latest,true);
 const functions=source.statements.filter(ts.isFunctionDeclaration).filter(node=>node.name?.text===name);
 expect(functions).toHaveLength(1);const body=functions[0].getText(source);expect(body.length).toBeGreaterThan(1000);return body;
}
function section(start:string,end:string){const a=core.indexOf(start),b=core.indexOf(end,a+start.length);expect(a).toBeGreaterThanOrEqual(0);expect(b).toBeGreaterThan(a);const value=core.slice(a,b);expect(value.length).toBeGreaterThan(300);return value;}
describe('canonical TOIL source lifecycle',()=>{
 it('locks the same employment before source proof and canonical ledger writes, reserves only a real accrual',()=>{
  const bank=section('export async function bankToilCreditTx(', 'export async function accrueSelfDeclaredToilTx(');
  const lock=bank.indexOf('pg_advisory_xact_lock'),proof=bank.indexOf('provenToilDurationTx'),ledger=bank.indexOf('.insert(leaveLedger)'),accrual=bank.indexOf('.insert(toilAccrual)'),reserve=bank.indexOf('await reserveOvertimeSettlementTx');
  expect(lock).toBeGreaterThan(0);expect(proof).toBeGreaterThan(lock);expect(ledger).toBeGreaterThan(proof);expect(accrual).toBeGreaterThan(ledger);expect(reserve).toBeGreaterThan(accrual);
  expect(bank).toContain("mode:'toil',toilAccrualId:acc.id");expect(bank).toContain('if(recordedSource)');expect(bank).not.toContain('lockOvertimeSourceTx');
  expect(bank).toContain('p.otMinutes>formula.minutes');expect(bank).not.toMatch(/p\.otMinutes\s*=\s*formula\.minutes/);
  expect(bank).toContain('overtimePattern:{...formula.audit,qualificationBasis:');expect(bank).toContain('consumedMinutes:otMinutes');expect(bank).toContain('p.otMinutes>formula.afterShiftMinutes');expect(bank).toContain('p.workedDayKind!==formula.recordedWorkedDayKind');
 });
 it('releases only the exact active claim after successful canonical reversal, preserving payroll closure',()=>{
  const reverse=section('export async function reverseLeaveCredit(', 'const LEAVE_CREDIT');
  expect(reverse.indexOf('pg_advisory_xact_lock')).toBeLessThan(reverse.indexOf(".for('update')"));
  expect(reverse).toContain('payrollStartedForDateTx');expect(reverse).toContain("eq(toilAccrual.status, 'active')");expect(reverse).toContain("status: 'reversed'");
  expect(reverse.indexOf('if (updated.length !== 1)')).toBeLessThan(reverse.indexOf('await releaseOvertimeSettlementTx'));
  expect(reverse).toContain('recordedSource.settlement.toilAccrualId!==acc.id');expect(reverse).toContain('expectedRevision:recordedSource.settlement.revision');
 });
 it('routes courtesy checks through the real context and captured formula classification',()=>{
  expect(core).toContain("formula.kind==='formula'?formula.recordedWorkedDayKind:await resolveWorkedDayKindTx");
  const request=readFileSync(resolve(__dirname,'../core/replacement-request.ts'),'utf8');
  expect(request).toContain('resolveWorkedDayKindTx(tx, employmentId, date,ctx)');expect(request).toContain('extendedHoursDayForEmploymentTx(tx, p.employmentId, l.workedDate,ctx)');
  expect(readFileSync(resolve(__dirname,'../core/leave-credit-request.ts'),'utf8')).toContain('leaveCreditRosterKindsTx(tx, employmentId, dates,ctx)');
  const uniform=adapterFunction('resolveOvertimeToilDurationTx');
  const lock=uniform.indexOf(".for('update')"),read=uniform.indexOf('const [day]');
  expect(lock).toBeGreaterThan(0);expect(read).toBeGreaterThan(lock);expect(uniform.slice(read)).not.toContain(".for('update')");
 });
 it('locks the dated source before full independent replay and keeps the source-date label separate from credit rules',()=>{
  const dated=adapterFunction('resolveOvertimePolicyDatedToilQualificationTx');
  const advisory=dated.indexOf('pg_advisory_xact_lock'),lock=dated.indexOf(".for('update')"),read=dated.indexOf('await readOvertimePolicyDurationTx');
  expect(advisory).toBeGreaterThan(0);expect(lock).toBeGreaterThan(advisory);expect(read).toBeGreaterThan(lock);
  expect(dated.slice(read)).not.toContain(".for('update')");
  expect(dated).toContain('attendancePolicyFinancialDurationContract');expect(dated).toContain('!isDeepStrictEqual(contract,stored.contract)');
  expect(dated).toContain('attendancePolicyDatedToilQualification(independent,p.claimWindow)');expect(dated).toContain('qualified.minutes!==contract.minutes');
  expect(dated).toContain('sourceCalendar.length!==1');expect(dated).toContain('sourceDayKind');
  expect(dated).not.toContain('calculateDatedToilCredit');expect(dated).not.toContain('bankToilCreditTx');
 });
 it('uses one shared allocation stage and salary-free metadata, never cash traces or another formula implementation',()=>{
  expect(adapter).toContain('canonicalOvertimeToilInputTx');expect(adapter).toContain('readOvertimeDurationDefinitionTx');expect(adapter).toContain('overtimeDurationProofInput');expect(adapter).toContain('evaluateOvertimePatternDuration');expect(adapter).toContain('intersectOvertimeDurationAfter');
  expect(adapter).not.toContain('readOvertimeCalculationTx');expect(adapter).not.toContain('compensation');expect(adapter).not.toContain('evaluation.trace');
  expect(adapter).toContain("marker?.status==='refused'&&marker.reason==='sourceUnavailable'");expect(adapter).toContain("duration.status!=='ready'");expect(adapter).toContain("numerator%denominator!==BigInt('0')");
 });
});
