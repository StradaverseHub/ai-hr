import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
const {push,router}=vi.hoisted(()=>{const push=vi.fn();return {push,router:{push}};});
vi.mock('next/navigation',()=>({useRouter:()=>router,usePathname:()=>'/admin/attendance/schedule'}));
vi.mock('../app/identity-actions',()=>({actAs:vi.fn()}));
import { AttendanceSettingsNavigation } from '../components/attendance-settings-navigation';
import { DevIdentitySwitcher } from '../components/dev-identity-switcher';
import { __resetUnsavedGuards, hasUnsavedChanges } from '../lib/unsaved-changes';
function contents(revision=0,catalogue=en){return <NextIntlClientProvider locale="en" messages={catalogue}><AttendanceSettingsNavigation formId="first-form" savedRevision={revision}/><a href="/admin/attendance/settings">Back</a><form id="first-form" method="post"><input aria-label="first" name="first" defaultValue="Saved"/><button>Save first</button></form><form method="post"><input aria-label="second" name="second" defaultValue="Saved"/><button>Save second</button></form><form method="get"><input aria-label="search" name="q"/></form></NextIntlClientProvider>;}
function fixture(){return render(contents());}
beforeEach(()=>{push.mockReset();vi.spyOn(window,'confirm').mockReturnValue(false);});
afterEach(()=>{cleanup();__resetUnsavedGuards();vi.restoreAllMocks();});
describe('settings navigation preserves independent form edits',()=>{
  it('does not treat a completed dev identity selection as another unsaved business form',()=>{
    // Keep this test at the real header/guard boundary: ignoring header values must not
    // suppress the warning when changing identity would leave an actual settings draft.
    vi.spyOn(HTMLFormElement.prototype,'requestSubmit').mockImplementation(()=>{});
    render(<NextIntlClientProvider locale="en" messages={en}><AttendanceSettingsNavigation/>
      <DevIdentitySwitcher current="first" principals={[{userId:'first',name:'First fixture',roles:['hr_admin']},{userId:'second',name:'Second fixture',roles:['hr_admin']}]}/>
      <form method="post"><input aria-label="business setting" name="setting" defaultValue="Saved"/><button>Save setting</button></form>
    </NextIntlClientProvider>);
    const identity=screen.getByRole('combobox'),business=screen.getByLabelText('business setting');
    fireEvent.change(identity,{target:{value:'second'}});
    expect(hasUnsavedChanges()).toBe(false);
    fireEvent.change(business,{target:{value:'Edited'}});
    expect(hasUnsavedChanges()).toBe(true);
    fireEvent.submit(business.closest('form')!);
    expect(window.confirm).not.toHaveBeenCalled();
    const switching=new Event('submit',{bubbles:true,cancelable:true});
    identity.closest('form')!.dispatchEvent(switching);
    expect(window.confirm).toHaveBeenCalledWith(en.attendanceSettingsHub.leaveOtherUnsaved);
    expect(switching.defaultPrevented).toBe(true);
    expect((business as HTMLInputElement).value).toBe('Edited');
  });
  it('does not prompt for GET filters or untouched forms',()=>{fixture();fireEvent.change(screen.getByLabelText('search'),{target:{value:'search'}});expect(hasUnsavedChanges()).toBe(false);fireEvent.click(screen.getByText('Back'));expect(window.confirm).not.toHaveBeenCalled();});
  it('cancelling Back preserves the edited form, while discard proceeds',()=>{fixture();fireEvent.change(screen.getByLabelText('first'),{target:{value:'Edited'}});expect(hasUnsavedChanges()).toBe(true);fireEvent.click(screen.getByText('Back'));expect(window.confirm).toHaveBeenCalled();expect(push).not.toHaveBeenCalled();expect((screen.getByLabelText('first') as HTMLInputElement).value).toBe('Edited');vi.mocked(window.confirm).mockReturnValue(true);fireEvent.click(screen.getByText('Back'));expect(push).toHaveBeenCalledWith('/admin/attendance/settings');});
  it('detects a controlled rule edit whose posted value lives in a hidden field',async()=>{
    function RuleForm(){const [value,setValue]=React.useState('and');return <NextIntlClientProvider locale="en" messages={en}><AttendanceSettingsNavigation/><form method="post"><select aria-label="logic" value={value} onChange={e=>setValue(e.target.value)}><option value="and">AND</option><option value="or">OR</option></select><input type="hidden" name="rules" value={value}/></form></NextIntlClientProvider>;}
    const pushed=vi.spyOn(window.history,'pushState');render(<RuleForm/>);
    expect(hasUnsavedChanges()).toBe(false);fireEvent.change(screen.getByLabelText('logic'),{target:{value:'or'}});
    await waitFor(()=>expect(pushed).toHaveBeenCalledTimes(1));expect(hasUnsavedChanges()).toBe(true);
    const unload=new Event('beforeunload',{cancelable:true});window.dispatchEvent(unload);expect(unload.defaultPrevented).toBe(true);
  });
  it('warns on browser Back, preserves edits on cancel and traverses past its sentinel on discard',()=>{
    const go=vi.spyOn(window.history,'go').mockImplementation(()=>{});
    const pushState=vi.spyOn(window.history,'pushState');
    fixture();fireEvent.change(screen.getByLabelText('first'),{target:{value:'Edited'}});
    expect(pushState).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(window.confirm).toHaveBeenCalledTimes(1);expect(go).not.toHaveBeenCalled();
    expect((screen.getByLabelText('first') as HTMLInputElement).value).toBe('Edited');
    vi.mocked(window.confirm).mockReturnValue(true);window.dispatchEvent(new PopStateEvent('popstate'));
    expect(go).toHaveBeenCalledWith(-2);
  });
  it('covers reload/close while dirty and stops warning after successful persistence',()=>{
    const view=fixture();fireEvent.change(screen.getByLabelText('first'),{target:{value:'Edited'}});
    const dirty=new Event('beforeunload',{cancelable:true});window.dispatchEvent(dirty);expect(dirty.defaultPrevented).toBe(true);
    view.rerender(contents(1));const saved=new Event('beforeunload',{cancelable:true});window.dispatchEvent(saved);expect(saved.defaultPrevented).toBe(false);
  });
  it('consumes only the current local submission receipt once on a same-page save', async()=>{
    fixture();const first=screen.getByLabelText('first') as HTMLInputElement,form=first.closest('form')!;
    form.setAttribute('data-attendance-save-scope','');
    fireEvent.change(first,{target:{value:'Reviewed'}});
    await act(async()=>form.setAttribute('data-attendance-saved-receipt','old-success'));
    expect(hasUnsavedChanges()).toBe(true); // A stale success URL is not a submission receipt.
    fireEvent.submit(form);
    const nonce=String(new FormData(form).get('__attendanceSaveNonce'));
    expect(nonce).toMatch(/^[a-f0-9]{32}$/);
    await act(async()=>form.setAttribute('data-attendance-saved-receipt','unrelated-refresh'));
    expect(hasUnsavedChanges()).toBe(true);
    await act(async()=>form.setAttribute('data-attendance-saved-receipt',nonce));
    expect(hasUnsavedChanges()).toBe(false);
    fireEvent.change(first,{target:{value:'New unsaved draft'}});
    await act(async()=>form.setAttribute('data-attendance-saved-receipt',nonce));
    expect(hasUnsavedChanges()).toBe(true); // Replaying an accepted receipt cannot acknowledge a new edit.
    fireEvent.submit(form);
    const secondNonce=String(new FormData(form).get('__attendanceSaveNonce'));
    expect(secondNonce).not.toBe(nonce);
    await act(async()=>form.setAttribute('data-attendance-saved-receipt',nonce));
    expect(hasUnsavedChanges()).toBe(true);
    await act(async()=>form.setAttribute('data-attendance-saved-receipt',secondNonce));
    expect(hasUnsavedChanges()).toBe(false);
  });
  it('retains baselines and the submitted nonce through a same-path catalogue refresh',async()=>{
    const view=fixture();vi.mocked(window.confirm).mockReturnValue(true);
    const first=screen.getByLabelText('first') as HTMLInputElement,second=screen.getByLabelText('second') as HTMLInputElement,form=first.closest('form')!;
    form.setAttribute('data-attendance-save-scope','');
    fireEvent.change(first,{target:{value:'Submitted'}});fireEvent.change(second,{target:{value:'Other draft'}});
    fireEvent.submit(form);const nonce=String(new FormData(form).get('__attendanceSaveNonce'));
    fireEvent.change(first,{target:{value:'Later edit'}});
    view.rerender(contents(0,JSON.parse(JSON.stringify(en)) as typeof en));
    expect(screen.getByLabelText('first')).toBe(first);expect(hasUnsavedChanges()).toBe(true);
    expect(new FormData(form).get('__attendanceSaveNonce')).toBe(nonce);
    await act(async()=>form.setAttribute('data-attendance-saved-receipt',nonce));
    fireEvent.change(second,{target:{value:'Saved'}});expect(hasUnsavedChanges()).toBe(true);
    fireEvent.change(first,{target:{value:'Submitted'}});expect(hasUnsavedChanges()).toBe(false);
  });

  it('keeps the accepted submission identity when a busy form is submitted again',()=>{
    fixture();const form=(screen.getByLabelText('first') as HTMLInputElement).closest('form')!;
    form.setAttribute('data-attendance-save-scope','');
    fireEvent.submit(form);const nonce=String(new FormData(form).get('__attendanceSaveNonce'));
    expect(nonce).toMatch(/^[a-f0-9]{32}$/);form.setAttribute('aria-busy','true');
    const repeated=new Event('submit',{bubbles:true,cancelable:true});form.dispatchEvent(repeated);
    expect(repeated.defaultPrevented).toBe(true);expect(new FormData(form).get('__attendanceSaveNonce')).toBe(nonce);
  });

  it('same-page receipts retain later edits and every other form baseline', async()=>{
    fixture();vi.mocked(window.confirm).mockReturnValue(true);
    const first=screen.getByLabelText('first') as HTMLInputElement,second=screen.getByLabelText('second') as HTMLInputElement,form=first.closest('form')!;
    form.setAttribute('data-attendance-save-scope','');
    fireEvent.change(first,{target:{value:'Submitted'}});fireEvent.change(second,{target:{value:'Other draft'}});
    fireEvent.submit(form);const nonce=String(new FormData(form).get('__attendanceSaveNonce'));
    fireEvent.change(first,{target:{value:'Edited after submit'}});
    await act(async()=>form.setAttribute('data-attendance-saved-receipt',nonce));
    expect(first.value).toBe('Edited after submit');expect(second.value).toBe('Other draft');
    expect(hasUnsavedChanges()).toBe(true);
    fireEvent.change(second,{target:{value:'Saved'}});expect(hasUnsavedChanges()).toBe(true);
    fireEvent.change(first,{target:{value:'Submitted'}});expect(hasUnsavedChanges()).toBe(false);
  });

  it('saving another form cannot silently discard an independent dirty form',()=>{fixture();fireEvent.change(screen.getByLabelText('first'),{target:{value:'Edited'}});const form=screen.getByLabelText('second').closest('form')!;const event=new Event('submit',{bubbles:true,cancelable:true});form.dispatchEvent(event);expect(event.defaultPrevented).toBe(true);expect(hasUnsavedChanges()).toBe(true);});
  it('keeps a submitted form dirty until successful persistence is acknowledged',()=>{const view=fixture();fireEvent.change(screen.getByLabelText('first'),{target:{value:'Edited'}});const form=screen.getByLabelText('first').closest('form')!;form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));expect(hasUnsavedChanges()).toBe(true);expect(window.confirm).not.toHaveBeenCalled();view.rerender(contents(1));expect(hasUnsavedChanges()).toBe(false);});
  it('acknowledges one saved form without losing another form’s edits',()=>{const view=fixture();fireEvent.change(screen.getByLabelText('first'),{target:{value:'Edited'}});fireEvent.change(screen.getByLabelText('second'),{target:{value:'Also edited'}});view.rerender(contents(1));expect(hasUnsavedChanges()).toBe(true);expect((screen.getByLabelText('second') as HTMLInputElement).value).toBe('Also edited');});
});
