import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
const {push}=vi.hoisted(()=>({push:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({push}),usePathname:()=>'/admin/attendance/schedule'}));
import { AttendanceSettingsNavigation } from '../components/attendance-settings-navigation';
import { __resetUnsavedGuards, hasUnsavedChanges } from '../lib/unsaved-changes';
function fixture(){return render(<NextIntlClientProvider locale="en" messages={en}><AttendanceSettingsNavigation/><a href="/admin/attendance/settings">Back</a><form method="post"><input aria-label="first" name="first" defaultValue="Saved"/><button>Save first</button></form><form method="post"><input aria-label="second" name="second" defaultValue="Saved"/><button>Save second</button></form><form method="get"><input aria-label="search" name="q"/></form></NextIntlClientProvider>);}
beforeEach(()=>{push.mockReset();vi.spyOn(window,'confirm').mockReturnValue(false);});
afterEach(()=>{cleanup();__resetUnsavedGuards();vi.restoreAllMocks();});
describe('settings navigation preserves independent form edits',()=>{
  it('does not prompt for GET filters or untouched forms',()=>{fixture();fireEvent.change(screen.getByLabelText('search'),{target:{value:'search'}});expect(hasUnsavedChanges()).toBe(false);fireEvent.click(screen.getByText('Back'));expect(window.confirm).not.toHaveBeenCalled();});
  it('cancelling Back preserves the edited form, while discard proceeds',()=>{fixture();fireEvent.change(screen.getByLabelText('first'),{target:{value:'Edited'}});expect(hasUnsavedChanges()).toBe(true);fireEvent.click(screen.getByText('Back'));expect(window.confirm).toHaveBeenCalled();expect(push).not.toHaveBeenCalled();expect((screen.getByLabelText('first') as HTMLInputElement).value).toBe('Edited');vi.mocked(window.confirm).mockReturnValue(true);fireEvent.click(screen.getByText('Back'));expect(push).toHaveBeenCalledWith('/admin/attendance/settings');});
  it('saving another form cannot silently discard an independent dirty form',()=>{fixture();fireEvent.change(screen.getByLabelText('first'),{target:{value:'Edited'}});const form=screen.getByLabelText('second').closest('form')!;const event=new Event('submit',{bubbles:true,cancelable:true});form.dispatchEvent(event);expect(event.defaultPrevented).toBe(true);expect(hasUnsavedChanges()).toBe(true);});
  it('does not warn when the only dirty form is submitted',()=>{fixture();fireEvent.change(screen.getByLabelText('first'),{target:{value:'Edited'}});const form=screen.getByLabelText('first').closest('form')!;form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));expect(hasUnsavedChanges()).toBe(false);expect(window.confirm).not.toHaveBeenCalled();});
});
