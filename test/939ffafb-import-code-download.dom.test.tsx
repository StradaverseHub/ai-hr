import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider, createTranslator } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import en from '../messages/en.json'; import ms from '../messages/ms.json'; import zh from '../messages/zh.json'; import ta from '../messages/ta.json'; import th from '../messages/th.json'; import viMessages from '../messages/vi.json';
import { EmployeeImport, type ImportReference } from '../app/(app)/admin/personnel/import/employee-import';
import { SectionImport } from '../app/(app)/admin/personnel/import/section-import';
import { EMPLOYEE_XLSX_COLUMNS } from '../lib/import-template-xlsx';
import { sectionTemplateColumns } from '../lib/import-sections';
import type { BuildXlsxOptions } from '../lib/spreadsheet';
const mocks=vi.hoisted(()=>({build:vi.fn(),allocations:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn()})}));
vi.mock('../lib/spreadsheet',()=>({buildXlsx:mocks.build}));
vi.mock('../app/(app)/admin/personnel/import/actions',()=>({validateImportAction:vi.fn(),commitImportAction:vi.fn()}));
vi.mock('../app/(app)/admin/personnel/import/cost-allocation-actions',()=>({allocationWorkbookReferencesAction:mocks.allocations}));
vi.mock('../app/(app)/admin/personnel/import/section-actions',()=>({validateSectionAction:vi.fn(),commitSectionAction:vi.fn(),registerRecordsAction:vi.fn()}));
const locales={en,ms,zh,ta,th,vi:viMessages};
const reference:ImportReference={departments:['D001'],positions:['P001'],costCenters:['C001'],states:[],countries:[],nationalities:[],relationships:[],familyRelationships:['child'],
 organisationByCompany:{company:{department:['D001'],position:['P001'],cost_center:['C001'],business_unit:['B001'],job_grade:['G001']}},
 organisationOptionsByCompany:{company:{department:[{value:'D001',label:'People department'}],position:[{value:'P001',label:'People partner'}],cost_center:[{value:'C001',label:'Central costs'}],business_unit:[{value:'B001',label:'Operations'}],job_grade:[{value:'G001',label:'Specialist'}]}},
 catalogs:{base:['001','002'],qualificationLevel:['Q001'],dependentRelationship:['child'],relationship:['REL001']},
 catalogOptions:{base:[{value:'001',label:'Shared base'},{value:'002',label:'Shared base'}],qualificationLevel:[{value:'Q001',label:'Academic qualification'}],dependentRelationship:[{value:'child',label:'Dependent child'}],relationship:[{value:'REL001',label:'Emergency relation'}]},
};
beforeEach(()=>{
 mocks.build.mockReset().mockResolvedValue(new Uint8Array([1]));mocks.allocations.mockReset().mockResolvedValue({ok:true,references:{companies:[{code:'FIC',name:'Fictional company'}],costCenters:[{companyCode:'FIC',code:'C001',label:'Central costs'}]}});
 Object.defineProperty(URL,'createObjectURL',{configurable:true,value:()=> 'blob:codes'});Object.defineProperty(URL,'revokeObjectURL',{configurable:true,value:()=>{}});
 vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{});
});
describe('actual full and update download handlers',()=>{
 it.each(Object.keys(locales) as (keyof typeof locales)[])('%s full download selects codes and retains allocation/related sheets',async locale=>{
  const messages=locales[locale],t=createTranslator({locale,messages,namespace:'people.import'});
  render(<NextIntlClientProvider locale={locale} messages={messages}><EmployeeImport companies={[{id:'company',name:'Fictional company'}]} defaultCompanyId="company" reference={reference}/></NextIntlClientProvider>);
  fireEvent.click(screen.getByRole('button',{name:t('downloadTemplateXlsx')}));await waitFor(()=>expect(mocks.build).toHaveBeenCalledOnce());
  const opts=mocks.build.mock.calls[0][2] as BuildXlsxOptions;
  expect(opts.validationLists?.find(list=>list.column===EMPLOYEE_XLSX_COLUMNS.indexOf('org_base'))?.values).toEqual(['001','002']);
  expect(opts.validationLists?.find(list=>list.column===EMPLOYEE_XLSX_COLUMNS.indexOf('department'))?.values).toEqual(['D001']);
  expect(opts.validationLists?.find(list=>list.column===EMPLOYEE_XLSX_COLUMNS.indexOf('employment_type'))?.values).toEqual(['full_time','part_time','contract','intern']);
  expect(opts.extraSheets?.map(sheet=>sheet.name)).toEqual(expect.arrayContaining(['Cost Center Allocations','Allocation Reference','Allocation Instructions','Family','Qualifications','Emergency Contacts','Reference','Instructions']));
  const rows=opts.extraSheets!.find(sheet=>sheet.name==='Reference')!.rows;
  expect(rows).toContainEqual(['001','Shared base']);expect(rows).toContainEqual(['D001','People department']);
  expect(opts.extraSheets!.find(sheet=>sheet.name==='Cost Center Allocations')!.validationLists?.find(list=>list.column===4)?.values).toEqual(['C001']);
 });
 it.each(['profile','family','qualification','emergency'] as const)('%s update handler uses codes while keeping readable Reference pairs',async section=>{
  const t=createTranslator({locale:'en',messages:en,namespace:'people.import'});
  render(<NextIntlClientProvider locale="en" messages={en}><SectionImport section={section} reference={reference}/></NextIntlClientProvider>);
  const sectionLabel=t(section==='emergency'?'sectionEmergency':section==='qualification'?'sectionQualification':section==='family'?'sectionFamily':'sectionProfile');
  fireEvent.click(screen.getByRole('button',{name:t('sectionDownloadTemplate',{section:sectionLabel})}));await waitFor(()=>expect(mocks.build).toHaveBeenCalledOnce());
  const opts=mocks.build.mock.calls[0][2] as BuildXlsxOptions,columns=sectionTemplateColumns(section);
  const field=section==='qualification'?'qualification':section==='profile'?'emergency_contact_relationship':'relationship';
  const expected=section==='qualification'?'Q001':section==='family'?'child':'REL001';
  expect(opts.validationLists?.find(list=>list.column===columns.indexOf(field))?.values).toEqual([expected]);
  const rows=opts.extraSheets!.find(sheet=>sheet.name==='Reference')!.rows;
  expect(rows.some(row=>row[0]===expected&&String(row[1]).length>0)).toBe(true);
 });
});
