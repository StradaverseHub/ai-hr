import { afterEach,describe,expect,it,vi } from 'vitest';
import { cleanup,fireEvent,render,screen,within,waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import { todayInKualaLumpur } from '../lib/hr-date';
import { saveRotationAction } from '../app/(app)/admin/attendance/schedule/rotation-actions';
import { ScheduleRotationEditor } from '../components/schedule-rotation-editor';
const {router}=vi.hoisted(()=>({router:{push:vi.fn()}}));
vi.mock('next/navigation',()=>({useRouter:()=>router,usePathname:()=>'/admin/attendance/schedule/group/edit'}));
vi.mock('../app/(app)/admin/attendance/schedule/rotation-actions',()=>({saveRotationAction:vi.fn()}));
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.mocked(saveRotationAction).mockReset();router.push.mockReset();});
const date=new Date(Date.parse(`${todayInKualaLumpur()}T00:00:00Z`)+86_400_000).toISOString().slice(0,10);
function mount(other=false){return render(<NextIntlClientProvider locale="en" messages={messages}><a href="/admin/attendance/settings">Back to settings</a><ScheduleRotationEditor
  ruleId="group" revision="revision" minimumDate={date} editing
  initial={{unit:'day',length:2,effectiveFrom:date,anchorDate:date,days:[{kind:'full',shiftId:'a'},{kind:'rest',shiftId:null}]}}
  shifts={['a','b'].map(id=>({id,name:id==='a'?'Morning':'Night',code:id,startTime:'08:00',endTime:'17:00',halfEnd:'12:30',fullMinutes:480,halfMinutes:240,archived:false,available:true,selected:id==='a'}))}/>{other&&<form id="other-form" method="post"><input name="other" aria-label="Other form" defaultValue="Original"/></form>}</NextIntlClientProvider>);}
describe('integrated allowed-shift and cycle editor',()=>{
  it('does not treat a shift search as an unsaved business edit',()=>{
    const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);mount();
    fireEvent.change(screen.getByRole('searchbox'),{target:{value:'Night'}});
    const link=screen.getByRole('link',{name:'Back to settings'});let intercepted:boolean|null=null;
    link.addEventListener('click',event=>{intercepted=event.defaultPrevented;event.preventDefault();},{once:true});
    fireEvent.click(link);
    expect(confirm).not.toHaveBeenCalled();expect(intercepted).toBe(false);
    expect(link).toHaveAttribute('href','/admin/attendance/settings');expect(router.push).not.toHaveBeenCalled();
  });
  it('protects bulk-selected filtered shifts as unsaved edits and submits the complete hidden pool',()=>{
    const confirm=vi.spyOn(window,'confirm').mockReturnValue(false),{container}=mount();
    fireEvent.change(screen.getByRole('searchbox'),{target:{value:'Night'}});
    fireEvent.click(screen.getByRole('button',{name:'Select all search results'}));
    const values=new FormData(container.querySelector('#attendance-rotation-group') as HTMLFormElement).getAll('allowedShiftIds');
    expect(values).toEqual(['a','b']);
    fireEvent.click(screen.getByRole('link',{name:'Back to settings'}));expect(confirm).toHaveBeenCalled();expect(router.push).not.toHaveBeenCalled();
  });
  it('makes an unsaved allowed shift immediately available in cycle selectors',()=>{
    const {container}=mount();
    fireEvent.click(screen.getByRole('checkbox',{name:/Night/}));
    const select=screen.getByRole('combobox',{name:'Shift 1'});
    expect(within(select).getByRole('option',{name:'b · Night'})).toBeTruthy();
    fireEvent.change(select,{target:{value:'b'}});
    expect(JSON.parse((container.querySelector('[name="cycle"]') as HTMLInputElement).value).days[0].shiftId).toBe('b');
    expect((screen.getByRole('button',{name:messages.admin.rotation.save}) as HTMLButtonElement).disabled).toBe(false);
  });
  it('warns before shrinking and preserves the full configured cycle when declined',()=>{
    const {container}=mount();const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);
    fireEvent.change(screen.getByRole('spinbutton'),{target:{value:'1'}});
    fireEvent.click(screen.getByRole('button',{name:messages.admin.rotation.generate}));
    expect(confirm).toHaveBeenCalledWith(messages.admin.rotation.replaceConfirm);
    expect(JSON.parse((container.querySelector('[name="cycle"]') as HTMLInputElement).value).days).toHaveLength(2);
  });
  it('removes working shift from rest/off and refuses an invalid working day pool',()=>{
    const {container}=mount();
    fireEvent.change(screen.getByRole('combobox',{name:'Day type 1'}),{target:{value:'off'}});
    expect(JSON.parse((container.querySelector('[name="cycle"]') as HTMLInputElement).value).days[0]).toEqual({kind:'off',shiftId:null});
    expect((screen.getByRole('button',{name:messages.admin.rotation.save}) as HTMLButtonElement).disabled).toBe(true);
  });
  it('rebases a successful save without a false navigation prompt',async()=>{
    const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);
    const {container}=mount();fireEvent.click(screen.getByRole('checkbox',{name:/Night/}));
    vi.mocked(saveRotationAction).mockResolvedValueOnce({saved:true,revision:'fresh-revision',savedVersionId:'version-1',savedEffectiveFrom:date});
    fireEvent.submit(container.querySelector('#attendance-rotation-group')!);
    await waitFor(()=>expect((container.querySelector('[name="revision"]') as HTMLInputElement).value).toBe('fresh-revision'));
    // The optimistic revision appears before the action transition finishes committing its navigation baseline.
    await waitFor(()=>expect(container.querySelector('#attendance-rotation-group')).toHaveAttribute('aria-busy','false'));
    const link=screen.getByRole('link',{name:'Back to settings'});let intercepted=false;
    link.addEventListener('click',event=>{intercepted=event.defaultPrevented;event.preventDefault();},{once:true});
    fireEvent.click(link);
    expect(confirm).not.toHaveBeenCalled();expect(intercepted).toBe(false);expect(router.push).not.toHaveBeenCalled();
    expect((screen.getByRole('checkbox',{name:/Night/}) as HTMLInputElement).checked).toBe(true);
    expect((container.querySelector('[name="cycle"]') as HTMLInputElement).value).toContain('\"shiftId\":\"a\"');
  });
  it('posts the fresh optimistic revision on the second save',async()=>{
    const {container}=mount();fireEvent.click(screen.getByRole('checkbox',{name:/Night/}));
    vi.mocked(saveRotationAction).mockResolvedValueOnce({saved:true,revision:'fresh-revision',savedVersionId:'version-1',savedEffectiveFrom:date})
      .mockResolvedValueOnce({saved:true,revision:'next-revision',savedVersionId:'version-2'});
    const form=container.querySelector('#attendance-rotation-group')!;fireEvent.submit(form);
    await waitFor(()=>expect((container.querySelector('[name="revision"]') as HTMLInputElement).value).toBe('fresh-revision'));
    await waitFor(()=>expect(form).toHaveAttribute('aria-busy','false'));
    const nextDate=new Date(Date.parse(`${date}T00:00:00Z`)+86_400_000).toISOString().slice(0,10);
    fireEvent.change(container.querySelector('[name="rotationEffectiveDraft"]')!,{target:{value:nextDate}});
    fireEvent.change(screen.getByRole('combobox',{name:'Day type 1'}),{target:{value:'half'}});fireEvent.submit(form);
    await waitFor(()=>expect(saveRotationAction).toHaveBeenCalledTimes(2));
    expect(vi.mocked(saveRotationAction).mock.calls[1][1].get('revision')).toBe('fresh-revision');
    await waitFor(()=>expect((container.querySelector('[name="revision"]') as HTMLInputElement).value).toBe('next-revision'));
  });
  it('keeps failed saves dirty and protects navigation',async()=>{
    const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);
    const {container}=mount();fireEvent.click(screen.getByRole('checkbox',{name:/Night/}));
    vi.mocked(saveRotationAction).mockResolvedValueOnce({error:'Save refused'});fireEvent.submit(container.querySelector('#attendance-rotation-group')!);
    await screen.findByText('Save refused');fireEvent.click(screen.getByRole('link',{name:'Back to settings'}));
    expect(confirm).toHaveBeenCalled();expect(router.push).not.toHaveBeenCalled();
    expect((container.querySelector('[name="revision"]') as HTMLInputElement).value).toBe('revision');
  });
  it('refuses submission when another dirty form has not been approved for leaving',()=>{
    const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);
    const {container}=mount(true);fireEvent.change(screen.getByRole('textbox',{name:'Other form'}),{target:{value:'Unsaved'}});
    fireEvent.click(screen.getByRole('checkbox',{name:/Night/}));
    expect(fireEvent.submit(container.querySelector('#attendance-rotation-group')!)).toBe(false);
    expect(confirm).toHaveBeenCalled();expect(saveRotationAction).not.toHaveBeenCalled();
  });
  it('keeps another independent form dirty after the rotation save succeeds',async()=>{
    const confirm=vi.spyOn(window,'confirm').mockReturnValue(true);
    const {container}=mount(true);fireEvent.change(screen.getByRole('textbox',{name:'Other form'}),{target:{value:'Unsaved'}});
    fireEvent.click(screen.getByRole('checkbox',{name:/Night/}));
    vi.mocked(saveRotationAction).mockResolvedValueOnce({saved:true,revision:'fresh-revision',savedVersionId:'version-1',savedEffectiveFrom:date});
    fireEvent.submit(container.querySelector('#attendance-rotation-group')!);
    await waitFor(()=>expect((container.querySelector('[name="revision"]') as HTMLInputElement).value).toBe('fresh-revision'));
    expect(confirm).toHaveBeenCalled();confirm.mockClear().mockReturnValue(false);
    fireEvent.click(screen.getByRole('link',{name:'Back to settings'}));
    expect(confirm).toHaveBeenCalled();expect(router.push).not.toHaveBeenCalled();
  });

});
