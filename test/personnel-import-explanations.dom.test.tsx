vi.mock('../app/(app)/admin/personnel/import/cost-allocation-actions',()=>({allocationWorkbookReferencesAction:async()=>({ok:true,references:{companies:[],costCenters:[]}})}));
vi.mock('../app/(app)/admin/personnel/import/movement-actions',()=>({movementCatalogAction:vi.fn(),previewMovementAction:vi.fn(),commitMovementAction:vi.fn()}));
import {fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import viMessages from '../messages/vi.json';
import {ImportWorkbench} from '../app/(app)/admin/personnel/import/import-workbench';
import type {ImportReference} from '../app/(app)/admin/personnel/import/employee-import';

const mocks=vi.hoisted(()=>({build:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn()})}));
vi.mock('../app/(app)/admin/personnel/import/actions',()=>({validateImportAction:vi.fn(),commitImportAction:vi.fn()}));
vi.mock('../app/(app)/admin/personnel/import/section-actions',()=>({validateSectionAction:vi.fn(),commitSectionAction:vi.fn(),registerRecordsAction:vi.fn()}));
vi.mock('../lib/spreadsheet',()=>({buildXlsx:mocks.build}));
const reference:ImportReference={departments:[],positions:[],costCenters:[],states:[],countries:[],nationalities:[],relationships:[],familyRelationships:[]};
const locales=[
  {locale:'en',messages:en,title:'Fields managed in Personnel'},
  {locale:'ms',messages:ms,title:'Medan yang diurus dalam Personel'},
  {locale:'zh',messages:zh,title:'在人事页面管理的字段'},
  {locale:'ta',messages:ta,title:'பணியாளர் பக்கத்தில் நிர்வகிக்கப்படும் புலங்கள்'},
  {locale:'th',messages:th,title:'ข้อมูลที่จัดการในหน้าบุคลากร'},
  {locale:'vi',messages:viMessages,title:'Các trường được quản lý trong Nhân sự'},
] as const;
function mount(entry:(typeof locales)[number]=locales[0]){return render(<NextIntlClientProvider locale={entry.locale} messages={entry.messages}><ImportWorkbench companies={[{id:'fixture',name:'Fixture'}]} defaultCompanyId="fixture" reference={reference}/></NextIntlClientProvider>);}
beforeEach(()=>{
  mocks.build.mockReset().mockResolvedValue(new Uint8Array([1]));
  Object.defineProperty(URL,'createObjectURL',{configurable:true,value:()=> 'blob:fixture'});
  Object.defineProperty(URL,'revokeObjectURL',{configurable:true,value:()=>{}});
  vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{});
});
describe('Personnel import explains fields kept in their own workflows',()=>{
  it.each(locales)('$locale exposes the explanation before a file is chosen',entry=>{
    mount(entry);
    const disclosure=screen.getByText(entry.title).closest('details');
    expect(disclosure).not.toBeNull();
    fireEvent.click(screen.getByText(entry.title));
    expect(within(disclosure!).getByText(entry.messages.people.detail.age)).toBeInTheDocument();
    expect(disclosure!.textContent).not.toMatch(/no section-import writer|mapEpfUiMode|resolveEpfElection/);
    expect(disclosure!.querySelectorAll('[data-personnel-exclusion]').length).toBeGreaterThan(50);
  });
  it('limits a section to its own tab and does not call a supported or alternate-caption field unimportable',()=>{
    mount();fireEvent.click(screen.getByRole('radio',{name:/^Profile /}));
    const disclosure=screen.getByText('Fields managed in Personnel').closest('details')!;
    expect(within(disclosure).getByText('Age')).toBeInTheDocument();
    expect(disclosure.querySelector('[data-personnel-exclusion="profile.personal_details.fullname"]')).toBeNull();
    expect(disclosure.querySelector('[data-personnel-exclusion="employment.organisation_assignment.companyname"]')).toBeNull();
    expect(disclosure.querySelector('[data-personnel-exclusion="family.family_and_dependents.icorpassport_8"]')).toBeNull();
    expect(disclosure.querySelector('[data-personnel-exclusion="documents.employee_documents.content"]')).toBeNull();
  });
  it.each(['full','profile'] as const)('puts the same actual exclusions and reasons in the %s workbook Instructions',async choice=>{
    mount();
    if(choice==='profile')fireEvent.click(screen.getByRole('radio',{name:/^Profile /}));
    fireEvent.click(screen.getByRole('button',{name:choice==='full'?'Download Excel template':'Download Profile template'}));
    await waitFor(()=>expect(mocks.build).toHaveBeenCalledOnce());
    const headers=mocks.build.mock.calls[0][0] as string[];
    const options=mocks.build.mock.calls[0][2] as {columnWidths:number[];extraSheets:{name:string;rows:(string|number)[][];columnWidths:number[]}[]};
    expect(options.columnWidths).toHaveLength(headers.length);
    for(const width of options.columnWidths)expect(width).toBeGreaterThanOrEqual(16);
    for(const sheet of options.extraSheets)expect(sheet.columnWidths?.length,sheet.name).toBeGreaterThan(0);
    const instructions=options.extraSheets.find(sheet=>sheet.name==='Instructions');
    expect(instructions).toBeDefined();
    const rows=instructions!.rows;
    expect(rows.some(row=>row.includes('Fields managed in Personnel'))).toBe(true);
    expect(rows.some(row=>row.includes('Age') && row.some(cell=>String(cell).includes('calculated')))).toBe(true);
    expect(rows.some(row=>row.includes('Profile photo') && row.some(cell=>String(cell).includes('Files')))).toBe(true);
    expect(rows.some(row=>row.includes('Company') && row.some(cell=>String(cell).includes('not imported')))).toBe(false);
  });
});
