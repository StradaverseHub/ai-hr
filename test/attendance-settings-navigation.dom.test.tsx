import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
const {push,router}=vi.hoisted(()=>{const push=vi.fn();return {push,router:{push}};});
vi.mock('next/navigation',()=>({useRouter:()=>router,usePathname:()=>'/admin/attendance/schedule'}));
import { AttendanceSettingsNavigation } from '../components/attendance-settings-navigation';
import { __resetUnsavedGuards, hasUnsavedChanges } from '../lib/unsaved-changes';
function contents(revision=0){return <NextIntlClientProvider locale="en" messages={en}><AttendanceSettingsNavigation formId="first-form" savedRevision={revision}/><a href="/admin/attendance/settings">Back</a><form id="first-form" method="post"><input aria-label="first" name="first" defaultValue="Saved"/><button>Save first</button></form><form method="post"><input aria-label="second" name="second" defaultValue="Saved"/><button>Save second</button></form><form method="get"><input aria-label="search" name="q"/></form></NextIntlClientProvider>;}
function fixture(){return render(contents());}
beforeEach(()=>{push.mockReset();vi.spyOn(window,'confirm').mockReturnValue(false);});
afterEach(()=>{cleanup();__resetUnsavedGuards();vi.restoreAllMocks();});
describe('settings navigation preserves independent form edits',()=>{
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
  it('saving another form cannot silently discard an independent dirty form',()=>{fixture();fireEvent.change(screen.getByLabelText('first'),{target:{value:'Edited'}});const form=screen.getByLabelText('second').closest('form')!;const event=new Event('submit',{bubbles:true,cancelable:true});form.dispatchEvent(event);expect(event.defaultPrevented).toBe(true);expect(hasUnsavedChanges()).toBe(true);});
  it('keeps a submitted form dirty until successful persistence is acknowledged',()=>{const view=fixture();fireEvent.change(screen.getByLabelText('first'),{target:{value:'Edited'}});const form=screen.getByLabelText('first').closest('form')!;form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));expect(hasUnsavedChanges()).toBe(true);expect(window.confirm).not.toHaveBeenCalled();view.rerender(contents(1));expect(hasUnsavedChanges()).toBe(false);});
  it('acknowledges one saved form without losing another form’s edits',()=>{const view=fixture();fireEvent.change(screen.getByLabelText('first'),{target:{value:'Edited'}});fireEvent.change(screen.getByLabelText('second'),{target:{value:'Also edited'}});view.rerender(contents(1));expect(hasUnsavedChanges()).toBe(true);expect((screen.getByLabelText('second') as HTMLInputElement).value).toBe('Also edited');});
});
