import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AttendanceSettingsActionForm, AttendanceSettingsSaveButton } from '../components/attendance-settings-action-form';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
const {router}=vi.hoisted(()=>({router:{push:vi.fn()}}));
vi.mock('next/navigation',()=>({useRouter:()=>router,usePathname:()=>'/admin/attendance/schedule/group/edit'}));
import {AttendanceSettingsNavigation} from '../components/attendance-settings-navigation';
import {__resetUnsavedGuards} from '../lib/unsaved-changes';
class Boundary extends React.Component<{children: React.ReactNode}, {error: unknown}> {
  state = {error: null as unknown};
  static getDerivedStateFromError(error: unknown) { return {error}; }
  render() { return this.state.error ? <p role="alert">{String(this.state.error)}</p> : this.props.children; }
}
afterEach(() => { cleanup(); __resetUnsavedGuards();vi.restoreAllMocks(); });
describe('Attendance settings action error boundary', () => {
  it('retains busy capture and its nonce until a settled action’s suspended render commits',async()=>{
    let released=false,finish!:()=>void,requestRender!:()=>void,actionSettled=false;
    const gate=new Promise<void>(resolve=>{finish=()=>{released=true;resolve();};});
    function Destination({version}:{version:number}){if(version&&!released)throw gate;return <p>Version {version}</p>;}
    const action=vi.fn(async(_data:FormData)=>{
      await Promise.resolve();requestRender();actionSettled=true;
      throw Object.assign(new Error('NEXT_REDIRECT'),{digest:'NEXT_REDIRECT;push;/admin/attendance/schedule/group/edit;303;',handled:true});
    });
    function Fixture(){
      const[version,setVersion]=React.useState(0);
      requestRender=()=>React.startTransition(()=>setVersion(1));
      return <NextIntlClientProvider locale="en" messages={en}><AttendanceSettingsNavigation/>
        <React.Suspense fallback={<p>Waiting</p>}><AttendanceSettingsActionForm submitAction={action} data-attendance-save-scope="">
          <input aria-label="Draft" name="draft" defaultValue="Saved"/><AttendanceSettingsSaveButton>Save</AttendanceSettingsSaveButton>
        </AttendanceSettingsActionForm><Destination version={version}/></React.Suspense>
      </NextIntlClientProvider>;
    }
    render(<Fixture/>);const button=screen.getByRole('button',{name:'Save'}) as HTMLButtonElement,form=button.closest('form')!;
    fireEvent.change(screen.getByRole('textbox',{name:'Draft'}),{target:{value:'Submitted'}});
    fireEvent.submit(form);const nonce=new FormData(form).get('__attendanceSaveNonce');
    await waitFor(()=>expect(actionSettled).toBe(true));
    expect(button.disabled).toBe(true);expect(form).toHaveAttribute('aria-busy','true');
    fireEvent.submit(form);expect(action).toHaveBeenCalledTimes(1);expect(new FormData(form).get('__attendanceSaveNonce')).toBe(nonce);
    await act(async()=>finish());
    await waitFor(()=>expect(button.disabled).toBe(false));expect(form).toHaveAttribute('aria-busy','false');
  });

  it('retains the native action contract when draft preservation is not requested', () => {
    render(<AttendanceSettingsActionForm preserveDrafts={false} submitAction={async () => {}}>
      <AttendanceSettingsSaveButton>Save</AttendanceSettingsSaveButton>
    </AttendanceSettingsActionForm>);
    expect(screen.getByRole('button', {name:'Save'}).closest('form')!.getAttribute('action')).not.toBeNull();
  });

  it('keeps native required validation and includes the accepted submitter in FormData', async () => {
    const action = vi.fn(async (_data: FormData) => {});
    render(<AttendanceSettingsActionForm submitAction={action}>
      <input aria-label="Name" name="name" required/>
      <AttendanceSettingsSaveButton name="intent" value="save">Save</AttendanceSettingsSaveButton>
    </AttendanceSettingsActionForm>);
    const button = screen.getByRole('button', {name:'Save'});
    const form = button.closest('form')!;
    expect(form.hasAttribute('action')).toBe(false);
    fireEvent.click(button);
    expect(action).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox', {name:'Name'}), {target:{value:'Edited'}});
    fireEvent.click(button);
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action.mock.calls[0][0].get('name')).toBe('Edited');
    expect(action.mock.calls[0][0].get('intent')).toBe('save');
  });

  it.each([
    ['ordinary failure', new Error('Save failed')],
    ['unhandled redirect', Object.assign(new Error('Unhandled redirect'), {digest:'NEXT_REDIRECT;push;/destination;303;'})],
  ])('does not swallow %s', async (_label, failure) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<Boundary><AttendanceSettingsActionForm submitAction={async () => {throw failure;}}>
      <input name="draft" defaultValue="Draft"/><AttendanceSettingsSaveButton>Save</AttendanceSettingsSaveButton>
    </AttendanceSettingsActionForm></Boundary>);
    fireEvent.submit(screen.getByRole('button', {name:'Save'}).closest('form')!);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', String(failure));
  });
});
