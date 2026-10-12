import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AttendanceSettingsActionForm, AttendanceSettingsSaveButton } from '../components/attendance-settings-action-form';
class Boundary extends React.Component<{children: React.ReactNode}, {error: unknown}> {
  state = {error: null as unknown};
  static getDerivedStateFromError(error: unknown) { return {error}; }
  render() { return this.state.error ? <p role="alert">{String(this.state.error)}</p> : this.props.children; }
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe('Attendance settings action error boundary', () => {
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
