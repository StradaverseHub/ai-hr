/** ccd3a65c — Import Employees: Import History button in the header (no embedded history box), full width on
 * all three pages, and the Information-Only Correction card listing the fields its template corrects. */
vi.mock('../app/admin/personnel/import/cost-allocation-actions',()=>({allocationWorkbookReferencesAction:async()=>({ok:true,references:{companies:[],costCenters:[]}})}));
vi.mock('../app/admin/personnel/import/movement-actions',()=>({movementCatalogAction:vi.fn(),previewMovementAction:vi.fn(),commitMovementAction:vi.fn()}));
vi.mock('../app/admin/personnel/information-correction-actions',()=>({previewInformationUploadAction:vi.fn(),confirmInformationUploadAction:vi.fn(),informationContextAction:vi.fn(),previewInformationAction:vi.fn(),saveInformationAction:vi.fn()}));
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fireEvent,render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import {describe,expect,it,vi} from 'vitest';
import en from '../messages/en.json';
import zh from '../messages/zh.json';
import {ImportWorkbench} from '../app/admin/personnel/import/import-workbench';
import type {ImportReference} from '../app/admin/personnel/import/employee-import';

vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn(),push:vi.fn()})}));
vi.mock('../app/admin/personnel/import/actions',()=>({validateImportAction:vi.fn(),commitImportAction:vi.fn()}));
vi.mock('../app/admin/personnel/import/section-actions',()=>({validateSectionAction:vi.fn(),commitSectionAction:vi.fn(),registerRecordsAction:vi.fn()}));
const reference:ImportReference={departments:[],positions:[],costCenters:[],states:[],countries:[],nationalities:[],relationships:[],familyRelationships:[]};
const source=(file:string)=>readFileSync(join(process.cwd(),file),'utf8');

describe('ccd3a65c Import Employees layout',()=>{
 it('puts Import History in the page header and drops the embedded history box and link',()=>{
  const page=source('app/admin/personnel/import/page.tsx');
  expect(page).toMatch(/actions=\{\s*<Link\s+href=\{IMPORT_HISTORY_PATH\}/);
  expect(page).toContain("t('historyButton')");
  expect(page).not.toMatch(/<ImportHistory\b/);expect(page).not.toContain('importHistoryLink');expect(page).not.toContain('listEmployeeImportRuns');
  expect(en.people.import.historyButton).toBe('Import History');
 });
 it('uses the full-width page container on Import Employees, Import History and both Import Logs',()=>{
  for(const file of ['app/admin/personnel/import/page.tsx','app/admin/personnel/import/history/page.tsx','app/admin/personnel/import/history/[attemptId]/page.tsx','app/admin/personnel/import/history/runs/[runId]/page.tsx']){
   const text=source(file);
   expect(text,file).toMatch(/className=\{pageWideCls\}/);
   expect(text,file).not.toMatch(/mx-auto[^"'`]*max-w-|max-w-[0-9a-z]+[^"'`]*mx-auto/);
  }
 });
 it.each([{locale:'en',messages:en,chip:'Direct Superior'},{locale:'zh',messages:zh,chip:'直属上级'}] as const)('$locale lists the corrected fields, highlights the new ones and points to the owners of the excluded ones',({locale,messages,chip})=>{
  render(<NextIntlClientProvider locale={locale} messages={messages}><ImportWorkbench companies={[{id:'fixture',name:'Fixture'}]} defaultCompanyId="fixture" reference={reference}/></NextIntlClientProvider>);
  fireEvent.click(screen.getByRole('radio',{name:new RegExp(messages.people.informationCorrection.title)}));
  const list=screen.getByRole('list',{name:messages.people.informationCorrection.templateFieldsLabel});
  const items=within(list).getAllByRole('listitem');
  expect(items).toHaveLength(22);
  expect(items.filter(item=>item.hasAttribute('data-added-field'))).toHaveLength(17);
  expect(within(list).getByText(chip)).toHaveAttribute('data-added-field');
  expect(within(list).getByText(messages.people.informationCorrection.fields.companyId)).not.toHaveAttribute('data-added-field');
  expect(screen.getByText(messages.people.informationCorrection.ownersNote)).toBeInTheDocument();
 });
});
