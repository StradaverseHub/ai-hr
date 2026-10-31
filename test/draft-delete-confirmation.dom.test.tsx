import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {NextIntlClientProvider} from 'next-intl';
import {readFileSync} from 'node:fs';
import type {DraftActivateActionResult,DraftDeleteActionResult} from '../lib/draft-action-result';
const mocks=vi.hoisted(()=>({save:vi.fn(),remove:vi.fn(),activate:vi.fn(),push:vi.fn(),refresh:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({push:mocks.push,refresh:mocks.refresh,replace:vi.fn()}),useSearchParams:()=>new URLSearchParams()}));
vi.mock('../app/(app)/admin/personnel/new/actions',()=>({saveDraftAction:mocks.save,discardDraftAction:mocks.remove,createEmployeeAction:mocks.activate}));
const {EmployeeWizard}=await import('../app/(app)/admin/personnel/new/wizard');
const catalog=(locale='en')=>JSON.parse(readFileSync(new URL('../messages/'+locale+'.json',import.meta.url),'utf8'));
const props={today:'2026-10-16',draftId:'fictional-draft-94b0-a',reservedEmployeeCode:'DEMO94B0001',initialStep:1,
  initialData:{profile:{fullName:'Fictional Draft A',primaryEmail:'draft-a@example.test',employeeCode:'DEMO94B0001'},employment:{companyId:'fictional-company',departmentId:'fictional-department',employmentType:'full_time',hiredOn:'2026-10-16'},payroll:{basicSalary:'2000'}},
  companies:[{id:'fictional-company',label:'Fictional Board Company'}],departments:[{id:'fictional-department',label:'Fictional Department',companies:'fictional-company'}],businessUnits:[],positions:[],costCenters:[],grades:[],managers:[],nationalityOptions:[],profileOptions:{salutation:[],religion:[],race:[]},relationshipOptions:[],countryOptions:[],stateOptions:[]};
const wrap=(locale='en',subject=props)=>render(<NextIntlClientProvider locale={locale} messages={catalog(locale)}><EmployeeWizard key={subject.draftId} {...subject}/></NextIntlClientProvider>);
const deferred=<T,>()=>{let resolve!:(result:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};};
beforeEach(()=>{for(const mock of Object.values(mocks))mock.mockReset();mocks.save.mockResolvedValue({id:props.draftId});mocks.remove.mockResolvedValue({ok:true} satisfies DraftDeleteActionResult);mocks.activate.mockResolvedValue({ok:true,employmentId:'fictional-employment'} satisfies DraftActivateActionResult);});
afterEach(cleanup);
describe('Draft Delete Record confirmation',()=>{
  it.each(['en','ms','ta','th','vi','zh'])('names the selected fictional Draft in %s and cancels without a request',async locale=>{
    const user=userEvent.setup(),words=catalog(locale).people.wizard;wrap(locale);
    const trigger=screen.getByRole('button',{name:words.deleteRecord});await user.click(trigger);
    const dialog=screen.getByRole('alertdialog',{name:words.deleteRecordTitle});
    expect(dialog.textContent).toContain('Fictional Draft A');expect(dialog.textContent).toContain('DEMO94B0001');
    const cancel=within(dialog).getByRole('button',{name:words.deleteRecordCancel});await waitFor(()=>expect(document.activeElement).toBe(cancel));
    await user.click(cancel);expect(mocks.remove).not.toHaveBeenCalled();
    await waitFor(()=>expect(screen.queryByRole('alertdialog')).toBeNull());expect(document.activeElement).toBe(trigger);
  });
  it('Escape and backdrop close without deleting, and reopening uses the current Draft name',async()=>{
    const user=userEvent.setup(),words=catalog().people.wizard;wrap();
    await user.click(screen.getByRole('button',{name:words.deleteRecord}));await user.keyboard('{Escape}');
    await waitFor(()=>expect(screen.queryByRole('alertdialog')).toBeNull());expect(mocks.remove).not.toHaveBeenCalled();
    const input=document.querySelector('input[data-personnel-field="profile.personal_details.fullname"]') as HTMLInputElement;
    await user.clear(input);await user.type(input,'Corrected Fictional Draft');
    await user.click(screen.getByRole('button',{name:words.deleteRecord}));expect(screen.getByRole('alertdialog').textContent).toContain('Corrected Fictional Draft');
    fireEvent.click(document.querySelector('[data-draft-delete-backdrop]')!);await waitFor(()=>expect(screen.queryByRole('alertdialog')).toBeNull());expect(mocks.remove).not.toHaveBeenCalled();
  });
  it('only Yes, Delete calls the existing action for that exact Draft, then navigates and refreshes',async()=>{
    const user=userEvent.setup(),words=catalog().people.wizard;wrap();await user.click(screen.getByRole('button',{name:words.deleteRecord}));
    expect(mocks.remove).not.toHaveBeenCalled();await user.click(screen.getByRole('button',{name:words.deleteRecordConfirm}));
    await waitFor(()=>expect(mocks.push).toHaveBeenCalledWith('/admin/personnel'));expect(mocks.remove).toHaveBeenCalledExactlyOnceWith(props.draftId);expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });
  it('guards synchronous double confirmation and retains pending/failure subject with a safe reference',async()=>{
    const user=userEvent.setup(),words=catalog().people.wizard,request=deferred<DraftDeleteActionResult>();mocks.remove.mockReturnValueOnce(request.promise);wrap();
    await user.click(screen.getByRole('button',{name:words.deleteRecord}));const confirm=screen.getByRole('button',{name:words.deleteRecordConfirm});
    act(()=>{fireEvent.click(confirm);fireEvent.click(confirm);});expect(mocks.remove).toHaveBeenCalledTimes(1);
    await user.keyboard('{Escape}');expect(screen.getByRole('alertdialog')).toBeTruthy();expect(mocks.push).not.toHaveBeenCalled();
    await act(async()=>{request.resolve({ok:false,kind:'system',reference:'DRAFT-A1B2C3D4'});await request.promise;});
    const dialog=screen.getByRole('alertdialog');expect(within(dialog).getByRole('alert').textContent).toContain('DRAFT-A1B2C3D4');expect(dialog.textContent).toContain('Fictional Draft A');
    expect(mocks.push).not.toHaveBeenCalled();await user.click(within(dialog).getByRole('button',{name:words.deleteRecordCancel}));expect(mocks.remove).toHaveBeenCalledTimes(1);
  });
  it('does not navigate or delete a newly opened Draft when an earlier confirmed request finishes',async()=>{
    const user=userEvent.setup(),words=catalog().people.wizard,request=deferred<DraftDeleteActionResult>();mocks.remove.mockReturnValueOnce(request.promise);const view=wrap();
    await user.click(screen.getByRole('button',{name:words.deleteRecord}));await user.click(screen.getByRole('button',{name:words.deleteRecordConfirm}));
    const next={...props,draftId:'fictional-draft-94b0-b',reservedEmployeeCode:'DEMO94B0002',initialData:{...props.initialData,profile:{...props.initialData.profile,fullName:'Fictional Draft B'}}};
    view.rerender(<NextIntlClientProvider locale="en" messages={catalog()}><EmployeeWizard key={next.draftId} {...next}/></NextIntlClientProvider>);
    await act(async()=>{request.resolve({ok:true});await request.promise;});
    expect(mocks.push).not.toHaveBeenCalled();expect(mocks.remove).toHaveBeenCalledExactlyOnceWith(props.draftId);expect(document.body.textContent).toContain('Fictional Draft B');
  });
  it('never displays thrown diagnostic messages and cannot carry a prior subject across a keyed Draft switch',async()=>{
    const user=userEvent.setup(),words=catalog().people.wizard;mocks.remove.mockRejectedValueOnce(new Error('SQLSTATE secret tenant password'));const view=wrap();
    await user.click(screen.getByRole('button',{name:words.deleteRecord}));await user.click(screen.getByRole('button',{name:words.deleteRecordConfirm}));
    await waitFor(()=>expect(screen.getByRole('alert').textContent).toBe(words.deleteFailed));expect(document.body.textContent).not.toContain('SQLSTATE');
    const next={...props,draftId:'fictional-draft-94b0-b',reservedEmployeeCode:'DEMO94B0002',initialData:{...props.initialData,profile:{...props.initialData.profile,fullName:'Fictional Draft B'}}};
    view.rerender(<NextIntlClientProvider locale="en" messages={catalog()}><EmployeeWizard key={next.draftId} {...next}/></NextIntlClientProvider>);
    expect(screen.queryByRole('alertdialog')).toBeNull();await user.click(screen.getByRole('button',{name:words.deleteRecord}));expect(screen.getByRole('alertdialog').textContent).toContain('Fictional Draft B');expect(mocks.remove).toHaveBeenCalledExactlyOnceWith(props.draftId);
  });
});
describe('safe activation outcomes on the retained Draft',()=>{
  it('renders finite validation and canonical field labels with an actionable tab link',async()=>{
    const user=userEvent.setup(),messages=catalog();mocks.activate.mockResolvedValueOnce({ok:false,kind:'validation',code:'reference_invalid',fields:[{tab:'job',field:'department'},{tab:'job',field:'SQL secret'}]});wrap();
    const activate=screen.getByRole('button',{name:messages.people.wizard.activate});expect((activate as HTMLButtonElement).disabled).toBe(false);await user.click(activate);
    const alert=await screen.findByRole('alert');expect(alert.textContent).toContain(messages.people.wizard.activationValidation.reference_invalid);expect(alert.textContent).not.toContain('SQL');
    await user.click(within(alert).getByRole('button',{name:messages.people.wizard.tabs.job+' — '+messages.people.detail.employmentInfo.department}));
    expect(screen.getByRole('tab',{name:messages.people.wizard.tabs.job}).getAttribute('aria-selected')).toBe('true');expect(mocks.push).not.toHaveBeenCalled();expect(document.body.textContent).toContain('DEMO94B0001');
  });
  it('only a confirmed activation navigates, and unknown system details stay private',async()=>{
    const user=userEvent.setup(),words=catalog().people.wizard;mocks.activate.mockResolvedValueOnce({ok:false,kind:'system',reference:'SQLSTATE private data'});wrap();await user.click(screen.getByRole('button',{name:words.activate}));
    expect((await screen.findByRole('alert')).textContent).toBe(words.activationFailed);expect(mocks.push).not.toHaveBeenCalled();
    // The failure renders before the first Activate's transition settles, and Activate stays disabled until it
    // does; a click in that window is dropped, so act only on the settled screen.
    await waitFor(()=>expect(screen.getByRole('button',{name:words.activate})).toBeEnabled(),{timeout:5000});
    await user.click(screen.getByRole('button',{name:words.activate}));expect(mocks.activate).toHaveBeenCalledTimes(2);await waitFor(()=>expect(mocks.push).toHaveBeenCalledWith('/admin/personnel/fictional-employment?from=personnel'));expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });
});
