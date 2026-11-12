/**
 * 82748f92 — the unsaved-changes check on the People › Settings section pages. Asking before leaving is the only
 * behaviour added: Cancel stays with the edits, OK leaves, and nothing is ever saved for the user.
 */
import React from 'react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
const {push,router,search}=vi.hoisted(()=>{const push=vi.fn();return {push,router:{push},search:{value:''}};});
vi.mock('next/navigation',()=>({useRouter:()=>router,usePathname:()=>'/admin/settings/people-general',useSearchParams:()=>new URLSearchParams(search.value)}));
import {PeopleSettingsNavigation} from '../components/people-settings-navigation';
import {useRegisteredUnsavedChanges} from '../components/use-registered-unsaved-changes';
import {__resetUnsavedGuards,hasUnsavedChanges} from '../lib/unsaved-changes';

const submitted=vi.fn();
function Page({saved='Off'}:{saved?:string}){
  return <NextIntlClientProvider locale="en" messages={en}>
    <a href="/admin/settings/people">Back to Settings</a>
    <a href="/admin/settings/system-labels/template" data-unsaved-guard="ignore">Download template</a>
    <PeopleSettingsNavigation/>
    <form method="post" onSubmit={e=>{e.preventDefault();submitted();}}><input aria-label="nric" name="allowDuplicatedNric" defaultValue={saved}/><button>Save setting</button></form>
    <form method="get"><input aria-label="search" name="q"/></form>
  </NextIntlClientProvider>;
}
function Grid(){
  const [rows,setRows]=React.useState(0);
  useRegisteredUnsavedChanges(rows>0,en.admin.systemLabels.unsavedChanges);
  return <button type="button" onClick={()=>setRows(r=>r+1)}>Add row</button>;
}
beforeEach(()=>{push.mockReset();submitted.mockReset();search.value='';vi.spyOn(window,'confirm').mockReturnValue(false);});
afterEach(()=>{cleanup();__resetUnsavedGuards();vi.restoreAllMocks();});

describe('People settings pages ask before leaving with unsaved changes',()=>{
  it('a clean page leaves without asking; GET filters and download links never count',()=>{
    render(<Page/>);
    fireEvent.change(screen.getByLabelText('search'),{target:{value:'Fictional'}});
    fireEvent.click(screen.getByText('Download template'));
    fireEvent.click(screen.getByText('Back to Settings'));
    expect(window.confirm).not.toHaveBeenCalled();
    expect(hasUnsavedChanges()).toBe(false);
  });
  it('Back to Settings on a changed form asks; Cancel stays and keeps the value; OK leaves and saves nothing',()=>{
    render(<Page/>);
    const field=screen.getByLabelText('nric') as HTMLInputElement;
    fireEvent.change(field,{target:{value:'On'}});
    expect(hasUnsavedChanges()).toBe(true);
    fireEvent.click(screen.getByText('Back to Settings'));
    expect(window.confirm).toHaveBeenCalledWith(en.peopleSettingsHub.leaveUnsaved);
    expect(window.confirm).toHaveBeenCalledWith('Leave this page and discard unsaved changes?');
    expect(push).not.toHaveBeenCalled();
    expect(field.value).toBe('On');
    vi.mocked(window.confirm).mockReturnValue(true);
    fireEvent.click(screen.getByText('Back to Settings'));
    expect(push).toHaveBeenCalledWith('/admin/settings/people');
    expect(submitted).not.toHaveBeenCalled();
  });
  it('closing or reloading the tab is warned while the form is changed',()=>{
    render(<Page/>);
    fireEvent.change(screen.getByLabelText('nric'),{target:{value:'On'}});
    const unload=new Event('beforeunload',{cancelable:true});window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
  });
  it('a formless System Labels grid edit counts as unsaved',()=>{
    render(<><Page/><Grid/></>);
    expect(hasUnsavedChanges()).toBe(false);
    fireEvent.click(screen.getByText('Add row'));
    fireEvent.click(screen.getByText('Back to Settings'));
    expect(window.confirm).toHaveBeenCalledWith(en.peopleSettingsHub.leaveUnsaved);
    expect(push).not.toHaveBeenCalled();
  });
  it('does not ask after a successful save that returns to the same page with a toast',async()=>{
    const view=render(<Page/>);
    fireEvent.change(screen.getByLabelText('nric'),{target:{value:'On'}});
    // The server action saved and redirected to ?toast=saved; the same form now shows the saved value.
    search.value='toast=saved';
    await act(async()=>{view.rerender(<Page saved="On"/>);});
    expect(hasUnsavedChanges()).toBe(false);
    fireEvent.click(screen.getByText('Back to Settings'));
    expect(window.confirm).not.toHaveBeenCalled();
    const unload=new Event('beforeunload',{cancelable:true});window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(false);
  });
});
