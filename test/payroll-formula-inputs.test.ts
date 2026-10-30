import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {eq} from 'drizzle-orm';
import * as s from '../db/schema';
import {readPayrollAttendanceHoursTx,readPayrollComponentInputsTx,readPayrollIndividualLedgerTx} from '../packs/payroll/service';
import {closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let base:Base,employee:string,otherEmployee:string,batch:string,otherBatch:string,regularCycle:string,offCycle:string;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();base=await seedBase();
 const employeeIds=[];for(let index=0;index<2;index++){const [person]=await owner.db.insert(s.person).values({tenantId:base.tenantId,fullName:'Fictional input-owner '+index,primaryEmail:randomUUID()+'@example.invalid'}).returning();const [employment]=await owner.db.insert(s.employment).values({tenantId:base.tenantId,personId:person.id,companyId:base.companyId,hiredOn:'2025-01-01'}).returning();employeeIds.push(employment.id);} [employee,otherEmployee]=employeeIds;
 const [regular]=await owner.db.insert(s.payrollCycle).values({tenantId:base.tenantId,companyId:base.companyId,name:'Fictional regular',code:'REG',runType:'regular'}).returning();regularCycle=regular.id;
 const [off]=await owner.db.insert(s.payrollCycle).values({tenantId:base.tenantId,companyId:base.companyId,name:'Fictional off cycle',code:'OFF',runType:'off_cycle'}).returning();offCycle=off.id;
 const [period]=await owner.db.insert(s.payPeriod).values({tenantId:base.tenantId,companyId:base.companyId,period:'2026-10'}).returning();
 const runs=await owner.db.insert(s.payrollBatch).values([{tenantId:base.tenantId,companyId:base.companyId,payPeriodId:period.id,payPeriod:'2026-10',batchDate:'2026-10-31',runSeq:1,runType:'regular',payrollCycleId:regularCycle},{tenantId:base.tenantId,companyId:base.companyId,payPeriodId:period.id,payPeriod:'2026-10',batchDate:'2026-10-31',runSeq:2,runType:'off_cycle',payrollCycleId:offCycle}]).returning();batch=runs[0].id;otherBatch=runs[1].id;
});
async function component(code:string){const [row]=await owner.db.insert(s.payComponent).values({tenantId:base.tenantId,code,name:'Fictional '+code,kind:'allowance',rule:{kind:'per_hour',rate:12.55},prorates:false,includedInEpf:true,includedInSocsoEis:true,includedInPcb:true,includedInHrdfBase:true,orpOvertime:true,orpUnpaidLeave:true,roundingMethod:'nearest',resolutionOrder:3,displayCategory:'overtime'}).returning();return row;}
const period={periodStart:'2026-10-01',periodEnd:'2026-10-31'};
describe('shared read-only Native payroll input owners',()=>{
 it('retains exact amounts, source IDs and every Native catalogue flag, with inclusive recurring boundaries and run/employee scope',async()=>{
  const catalogue=await component('INPUT_OWNER');const [included]=await owner.db.insert(s.employmentPayComponent).values({tenantId:base.tenantId,employmentId:employee,componentId:catalogue.id,amount:'123.45',validFrom:'2026-10-01',validTo:'2026-10-01',prorateOverride:false}).returning();
  await owner.db.insert(s.employmentPayComponent).values([{tenantId:base.tenantId,employmentId:employee,componentId:catalogue.id,amount:'99.99',validFrom:'2026-08-01',validTo:'2026-09-30'},{tenantId:base.tenantId,employmentId:otherEmployee,componentId:catalogue.id,amount:'88.88',validFrom:'2026-10-01'}]);
  const [oneOff]=await owner.db.insert(s.payrollBatchComponent).values({tenantId:base.tenantId,batchId:batch,employmentId:employee,componentId:catalogue.id,amount:'0.01'}).returning();
  await owner.db.insert(s.payrollBatchComponent).values({tenantId:base.tenantId,batchId:otherBatch,employmentId:employee,componentId:catalogue.id,amount:'700.00'});
  const result=await owner.db.transaction(tx=>readPayrollComponentInputsTx(tx,{...period,employmentIds:[employee],batchId:batch}));
  expect(result.recurring).toHaveLength(1);expect(result.recurring[0]).toMatchObject({sourceId:included.id,employmentId:employee,amount:'123.45',prorateOverride:false,code:catalogue.code,kind:'allowance',epf:true,socso:true,pcb:true,hrdf:true,orpOvertime:true,orpUnpaidLeave:true,prorates:false,rounding:'nearest',rule:catalogue.rule,resolutionOrder:3,displayCategory:'overtime',formulaContext:null});
  expect(result.batch).toHaveLength(1);expect(result.batch[0]).toMatchObject({sourceId:oneOff.id,amount:'0.01',oneOff:true});
  expect(await owner.db.transaction(tx=>readPayrollComponentInputsTx(tx,{...period,employmentIds:[],batchId:batch}))).toEqual({recurring:[],batch:[]});
  expect((await owner.db.transaction(tx=>readPayrollComponentInputsTx(tx,{...period,employmentIds:[employee]}))).batch).toEqual([]);
 });
 it('reads only same-run unconsumed/reconsumed transactions and intended-cycle period rows without attaching or consuming anything',async()=>{
  const catalogue=await component('LEDGER_OWNER');
  const values=[{batchId:batch,consumedBatchId:null,notes:'attached unpaid'},{batchId:batch,consumedBatchId:batch,notes:'same-run replay'},{batchId:batch,consumedBatchId:otherBatch,notes:'paid elsewhere'},{batchId:null,consumedBatchId:null,notes:'regular unnamed',intendedCycleId:null},{batchId:null,consumedBatchId:null,notes:'regular named',intendedCycleId:regularCycle},{batchId:null,consumedBatchId:null,notes:'off-cycle named',intendedCycleId:offCycle},{batchId:null,consumedBatchId:otherBatch,notes:'unattached but paid',intendedCycleId:null}];
  await owner.db.insert(s.payrollIndividualTxn).values(values.map(value=>({tenantId:base.tenantId,companyId:base.companyId,payPeriod:'2026-10',employmentId:employee,componentId:catalogue.id,kind:'earning' as const,txnDate:'2026-10-15',amount:'12.34',source:'import',sourceRef:randomUUID(),...value})));
  await owner.db.insert(s.payrollIndividualTxn).values({tenantId:base.tenantId,batchId:batch,employmentId:otherEmployee,kind:'earning',txnDate:'2026-10-15',amount:'900.00',notes:'other employee'});
  const before=await owner.db.select().from(s.payrollIndividualTxn);
  const attached=await owner.db.transaction(tx=>readPayrollIndividualLedgerTx(tx,{batchId:batch}));expect(attached.map(row=>row.notes).sort()).toEqual(['attached unpaid','other employee','same-run replay']);expect(attached.find(row=>row.notes==='attached unpaid')).toMatchObject({amount:'12.34',compRule:catalogue.rule,compResolutionOrder:3,compEpf:true,compSocso:true,compPcb:true,compHrdf:true});
  const unattached={companyId:base.companyId,payPeriod:'2026-10',payrollCycleId:regularCycle,runType:'regular'};
  expect((await owner.db.transaction(tx=>readPayrollIndividualLedgerTx(tx,{batchId:batch,employmentIds:[employee]}))).map(row=>row.notes).sort()).toEqual(['attached unpaid','same-run replay']);expect(await owner.db.transaction(tx=>readPayrollIndividualLedgerTx(tx,{batchId:batch,employmentIds:[]}))).toEqual([]);
  const regular=await owner.db.transaction(tx=>readPayrollIndividualLedgerTx(tx,{batchId:batch,unattached,employmentIds:[employee]}));expect(regular.map(row=>row.notes).sort()).toEqual(['attached unpaid','regular named','regular unnamed','same-run replay']);
  const off=await owner.db.transaction(tx=>readPayrollIndividualLedgerTx(tx,{unattached:{...unattached,payrollCycleId:offCycle,runType:'off_cycle'}}));expect(off.map(row=>row.notes)).toEqual(['off-cycle named']);
  expect(await owner.db.transaction(tx=>readPayrollIndividualLedgerTx(tx,{unattached:{...unattached,payrollCycleId:null,runType:'off_cycle'}}))).toEqual([]);
  expect(await owner.db.transaction(tx=>readPayrollIndividualLedgerTx(tx,{}))).toEqual([]);expect(await owner.db.select().from(s.payrollIndividualTxn)).toEqual(before);
 });
 it('uses actual attendance minutes in the inclusive period without fabricating a missing employee entry',async()=>{
  await owner.db.insert(s.attendance).values([{tenantId:base.tenantId,employmentId:employee,attendanceDate:'2026-10-01',workedMinutes:61},{tenantId:base.tenantId,employmentId:employee,attendanceDate:'2026-10-31',workedMinutes:59},{tenantId:base.tenantId,employmentId:employee,attendanceDate:'2026-09-30',workedMinutes:600},{tenantId:base.tenantId,employmentId:otherEmployee,attendanceDate:'2026-10-15',workedMinutes:300}]);
  const hours=await owner.db.transaction(tx=>readPayrollAttendanceHoursTx(tx,{...period,employmentIds:[employee]}));expect([...hours]).toEqual([[employee,2]]);expect(hours.has(otherEmployee)).toBe(false);expect((await owner.db.transaction(tx=>readPayrollAttendanceHoursTx(tx,{...period,employmentIds:[]}))).size).toBe(0);
  expect(await owner.db.select().from(s.attendance).where(eq(s.attendance.employmentId,employee))).toHaveLength(3);
 });
});
