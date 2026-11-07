import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {NextIntlClientProvider} from 'next-intl';
import * as Dialog from '@radix-ui/react-dialog';
import type {ReactNode} from 'react';
import en from '../messages/en.json';
import {MultiSelectPopover} from '../components/ui/multi-select-popover';
import {RequestLeaveDialog} from '../components/leave/request-leave-dialog';
import {PersonnelOrganisationFilters} from '../app/admin/personnel/organisation-filters';
import {PermissionMatrix} from '../app/admin/settings/profile-requests/permission-matrix';
import {CompanySwitcher} from '../components/company-switcher';
const navigation=vi.hoisted(()=>({push:vi.fn(),replace:vi.fn(),refresh:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>navigation,useSearchParams:()=>new URLSearchParams(),usePathname:()=>'/'}));
vi.mock('../app/scope-actions',()=>({setCompanyScope:vi.fn()}));
vi.mock('../components/ui-theme-context',()=>({useIsMonolith:()=>false}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
function mount(children:ReactNode){return render(<NextIntlClientProvider locale="en" messages={en}>{children}</NextIntlClientProvider>);}

describe('audit picker recovery',()=>{
 it('announces an empty search and gives Escape to the picker before its dialog',async()=>{
  mount(<Dialog.Root defaultOpen><Dialog.Portal><Dialog.Content aria-describedby={undefined}><Dialog.Title>Parent dialog</Dialog.Title><MultiSelectPopover label="Company" allLabel="All companies" options={[{id:'a',name:'Allowed company'}]} selected={new Set(['a'])} name="company" onChange={()=>{}} searchPlaceholder="Search company" selectedCount={n=>`${n} selected`} selectAllLabel="Select all" clearAllLabel="Clear"/></Dialog.Content></Dialog.Portal></Dialog.Root>);
  const trigger=screen.getByRole('button',{name:'Company 1 selected'});
  await userEvent.click(trigger);
  const search=screen.getByPlaceholderText('Search company');
  await userEvent.type(search,'missing company');
  expect(screen.getByRole('status')).toHaveTextContent(en.common.noSearchResults);
  await userEvent.keyboard('{Escape}');
  expect(screen.queryByPlaceholderText('Search company')).toBeNull();
  expect(screen.getByRole('dialog',{name:'Parent dialog'})).toBeVisible();
  expect(trigger).toHaveFocus();
  expect(document.querySelector('input[type="hidden"][name="company"]')).toHaveValue('a');
 });
 it('dismisses the Personnel filter by Escape and returns to the trigger',async()=>{
  mount(<PersonnelOrganisationFilters fields={[]} values={{quality:['suspected_duplicate']}} companies={[]} labels={{filter:'Filter',apply:'Apply',clearAll:'Clear all',activeCount:'1'}} companySearchLabel="Search companies" canInspectDuplicates={false}/>);
  const trigger=screen.getByRole('button',{name:'Filter'});await userEvent.click(trigger);
  const dialog=screen.getByRole('dialog',{name:'Filter'});
  expect(new FormData(dialog.querySelector('form')!).getAll('quality')).toEqual(['suspected_duplicate']);
  await userEvent.keyboard('{Escape}');expect(screen.queryByRole('dialog')).toBeNull();expect(trigger).toHaveFocus();
 });
 it('explains a cleared company draft without submitting an empty scope',async()=>{
  const submit=vi.spyOn(HTMLFormElement.prototype,'requestSubmit').mockImplementation(()=>{});
  mount(<CompanySwitcher companies={[{id:'a',name:'Allowed company'}]} selected={['a']}/>);
  const trigger=screen.getByRole('button',{name:'All companies'});await userEvent.click(trigger);
  await userEvent.click(screen.getByRole('checkbox',{name:'Allowed company'}));
  expect(submit).not.toHaveBeenCalled();expect(screen.getByRole('status')).toHaveTextContent(en.topbar.pendingCompanySelection);
  await userEvent.keyboard('{Escape}');expect(screen.queryByRole('checkbox')).toBeNull();expect(trigger).toHaveFocus();
  await userEvent.click(trigger);expect(screen.getByRole('checkbox')).toBeChecked();submit.mockRestore();
 });
});

describe('leave submission retains correction context',()=>{
 it('keeps the reason and file on a server rejection, then closes on confirmed success',async()=>{
  const submit=vi.fn().mockResolvedValueOnce({error:'No entitlement is configured.'}).mockResolvedValueOnce({redirectTo:'/leave?toast=Saved'});
  mount(<RequestLeaveDialog types={[{id:'annual',label:'Annual leave',durations:null}]} startDefault="2026-11-09" ownEmploymentId="own" submitAction={submit} summaryAction={async()=>null}/>);
  await userEvent.click(screen.getByRole('button',{name:en.leave.requestLeave}));
  const dialog=screen.getByRole('dialog');const reason=dialog.querySelector<HTMLInputElement>('input[name="reason"]')!;
  await userEvent.type(reason,'Keep this reason');
  const file=dialog.querySelector<HTMLInputElement>('input[type="file"]');
  const document=new File(['fixture'],'fixture.pdf',{type:'application/pdf'});
  expect(file).not.toBeNull();
  await userEvent.upload(file!,document);
  await userEvent.click(within(dialog).getByRole('button',{name:en.leave.submitRequest}));
  await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('No entitlement is configured.'));
  expect(screen.getByRole('dialog')).toBeVisible();expect(reason).toHaveValue('Keep this reason');
  expect(file!.files?.[0]).toBe(document);
  expect(submit.mock.calls[0][0].get('reason')).toBe('Keep this reason');expect(submit.mock.calls[0][1]).toBe(true);
  await userEvent.click(within(dialog).getByRole('button',{name:en.leave.submitRequest}));
  await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());expect(navigation.push).toHaveBeenCalledWith('/leave?toast=Saved');
 });
 it('blocks a known zero-day selection and explains how to recover',async()=>{
  const submit=vi.fn();
  mount(<RequestLeaveDialog types={[{id:'annual',label:'Annual leave',durations:null}]} startDefault="2026-11-07" ownEmploymentId="own" submitAction={submit} previewAction={async()=>({days:0,balanceAvailable:0,balanceAfter:0,hasHalfScheduleDate:false,isEmergencySplit:false})} summaryAction={async()=>null}/>);
  await userEvent.click(screen.getByRole('button',{name:en.leave.requestLeave}));
  await waitFor(()=>expect(screen.getByText(en.leave.zeroDaysHint)).toBeVisible());
  expect(screen.getByRole('button',{name:en.leave.submitRequest})).toBeDisabled();expect(submit).not.toHaveBeenCalled();
 });
});

it('permission search preserves values and group controls for hidden fields',async()=>{
 const rows=['Alpha','Beta'].map((label,i)=>({id:label,label,group:'Profile',tab:'profile',section:'personal',tabLabel:'Profile',canEdit:true,permission:i===0?'editable' as const:'hide' as const,primaryOnly:false,waiting:0}));
 const view=render(<form><PermissionMatrix rows={rows} disabled={false} labels={{field:'Field',search:'Search fields',sectionFilter:'Section',allSections:'All sections',editable:'Editable',viewOnly:'View only',hide:'Hide',all:'All',attachmentRequired:'Required',attachmentOptional:'Optional',sectionPermission:'Section permission'}}/></form>);
 const before=[...new FormData(view.container.querySelector('form')!).entries()];
 await userEvent.type(screen.getByRole('searchbox',{name:'Search fields'}),'Alpha');
 expect(screen.queryByRole('checkbox',{name:'Beta: Hide'})).toBeNull();
 expect([...new FormData(view.container.querySelector('form')!).entries()]).toEqual(before);
 await userEvent.clear(screen.getByRole('searchbox',{name:'Search fields'}));expect(screen.getByRole('checkbox',{name:'Beta: Hide'})).toBeChecked();
});
