import {describe,it,expect} from 'vitest';
import {COMPARISON_KINDS} from '../core/movement-kinds';
import {movementFormRequired} from '../lib/movement-form-contract';
import {movementImportCellIssues,movementImportRequired,parseMovementImport} from '../lib/movement-import-contract';
import {movementWorkbookLayout,movementWorkbookRequirements} from '../lib/movement-workbook-layout';
import {todayInKualaLumpur} from '../lib/hr-date';
import {toCsv} from '../lib/csv';

const today=todayInKualaLumpur();
const row=(kind:string,extra:Record<string,string>={})=>{
 const fields={employee_code:'OMIT-1',event_type:kind,effective_date:today,...extra};
 const parsed=parseMovementImport(toCsv([Object.keys(fields),Object.values(fields)]));
 expect(parsed.fileErrors).toEqual([]);expect(parsed.records).toHaveLength(1);
 return parsed.records[0];
};
describe('Movement import omission preserves the existing comparison facts',()=>{
 it.each(COMPARISON_KINDS)('%s admits an omitted Department before canonical live-state/no-op checks',kind=>{
  const record=row(kind,kind==='entityTransfer'?{company_id:'11111111-1111-4111-8111-111111111111'}:{});
  expect(record.cells).not.toHaveProperty('departmentId');
  expect(movementImportCellIssues(record,kind)).toEqual([]);
 });
 it('a blank Department and an absent Department both preserve omission; manual requiredness is unchanged',()=>{
  const omitted=row('promotion',{basic_salary:'3500'}),blank=row('promotion',{basic_salary:'3500',department_id:'   '});
  expect(blank.cells).toEqual(omitted.cells);expect(blank.cells).not.toHaveProperty('departmentId');
  expect(movementImportCellIssues(blank,'promotion')).toEqual([]);
  expect(movementFormRequired('departmentId','promotion')).toBe(true);
  expect(movementImportRequired('departmentId','promotion')).toBe(false);
 });
 it('does not turn an omitted Entity Transfer destination into the current company or authorize Company on other events',()=>{
  expect(movementImportCellIssues(row('entityTransfer'),'entityTransfer')).toEqual(['required:companyId']);
  expect(movementImportCellIssues(row('promotion',{company_id:'11111111-1111-4111-8111-111111111111'}),'promotion')).toEqual(['not_applicable:companyId']);
 });
 it('retains mandatory lifecycle end dates, termination reason and conditional resignation date',()=>{
  expect(movementImportCellIssues(row('probationExtension'),'probationExtension')).toEqual(['required:endDate']);
  expect(movementImportCellIssues(row('termination'),'termination')).toEqual(['required:endDate','required:terminationReasonCode']);
  expect(movementImportCellIssues(row('termination',{end_date:today,termination_reason_code:'resignation'}),'termination')).toEqual(['required:resignationDate']);
  expect(movementImportCellIssues(row('termination',{end_date:today,termination_reason_code:'contract_expiry'}),'termination')).toEqual([]);
 });
 it('keeps malformed/event/date and populated inapplicable inputs refused',()=>{
  expect(row('',{}).errors).toContain('event_type_required');
  expect(row('promotion',{effective_date:''}).errors).toContain('invalid_effective_date');
  expect(movementImportCellIssues(row('secondment',{basic_salary:'3500'}),'secondment')).toEqual(['not_applicable:basicSalary']);
  expect(movementImportCellIssues(row('probationExtension',{end_date:'2026-02-30'}),'probationExtension')).toContain('invalid_date:endDate');
 });
 it('per-type guidance retains omission and explicit Entity Transfer destination rules',()=>{
  const resolve=(_key:string,fallback:string)=>fallback,promotion={code:'promotion',label:null,behaviour:'promotion'},transfer={code:'entityTransfer',label:null,behaviour:'entityTransfer'};
  const p=movementWorkbookRequirements(promotion,movementWorkbookLayout(promotion,resolve)),t=movementWorkbookRequirements(transfer,movementWorkbookLayout(transfer,resolve));
  expect(p.required).not.toContain('Department');expect(p.optional).toContain('Department');expect(t.required).toContain('Company');expect(t.required).not.toContain('Department');
 });
});
