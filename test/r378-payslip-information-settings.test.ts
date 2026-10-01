import { describe,it,expect,beforeAll,beforeEach,afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { adminCtx,owner,migrateTestDb,resetDb,seedBase,closeAll,type Base } from './harness';
import * as schema from '../db/schema';
import { getPayslipInformationSettings,setPayslipInformationSettings } from '../core/payslip-information-settings';
import { DEFAULT_PAYSLIP_INFORMATION_FIELDS } from '../core/payslip-information';
let base:Base;
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();base=await seedBase()});afterAll(closeAll);
const ctx=()=>({...adminCtx(base),grants:[{role:'hr_admin',companyId:base.companyId}]});
describe('company-owned payslip display setting',()=>{
 it('has explicit defaults, saves an empty selection, persists ordered independent company choices and an audit event',async()=>{
  expect(await getPayslipInformationSettings(ctx(),base.companyId)).toEqual(DEFAULT_PAYSLIP_INFORMATION_FIELDS);
  await setPayslipInformationSettings(ctx(),base.companyId,['branch','employee','daysWorked']);
  expect(await getPayslipInformationSettings(ctx(),base.companyId)).toEqual(['employee','branch','daysWorked']);
  await setPayslipInformationSettings(ctx(),base.companyId,[]);
  expect(await getPayslipInformationSettings(ctx(),base.companyId)).toEqual([]);
  const events=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType,'payslip-information.changed'));
  expect(events).toHaveLength(2);
 });
 it('rejects unknown fields and another company without changing the saved setting',async()=>{
  await setPayslipInformationSettings(ctx(),base.companyId,['employee']);
  await expect(setPayslipInformationSettings(ctx(),base.companyId,['bankAccount'])).rejects.toThrow('Unknown');
  await expect(setPayslipInformationSettings(ctx(),randomUUID(),['employee'])).rejects.toThrow('Forbidden');
  await expect(getPayslipInformationSettings({...ctx(),roles:['employee'],grants:[]},base.companyId)).rejects.toThrow('Forbidden');
  expect(await getPayslipInformationSettings(ctx(),base.companyId)).toEqual(['employee']);
 });
});
