import React from 'react';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {ClientTabs} from '../components/personnel-tabs';
import {TabSaveScope} from '../components/tab-save-scope';
import {__resetUnsavedGuards} from '../lib/unsaved-changes';
import {HolidayCalendarAssignments} from '../app/(app)/admin/personnel/[employmentId]/holiday-calendar-assignments';
const state=vi.hoisted(()=>({save:vi.fn(),refresh:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:state.refresh})}));
vi.mock('../app/(app)/admin/personnel/[employmentId]/holiday-calendar-actions',()=>({saveHolidayCalendarAssignmentAction:state.save}));
const nativeReplace=window.history.replaceState;
const require=createRequire(import.meta.url);
const nextSource=readFileSync(require.resolve('next/dist/client/components/app-router.js'),'utf8');
function between(start:string,end:string){
 const a=nextSource.indexOf(start),b=nextSource.indexOf(end,a+start.length);
 expect(a,'the installed Next history implementation is present').toBeGreaterThanOrEqual(0);
 expect(b,'the installed Next history implementation has a bounded end').toBeGreaterThan(a);
 const body=nextSource.slice(a,b);expect(body.length).toBeGreaterThan(200);return body;
}
// Execute the installed Next history adapter, rather than a mock that always updates router state.
// This is the boundary where forwarding Next's __NA marker bypassed canonical URL synchronization.
function installNextHistory(onCanonicalUrl:(url:string|URL|null|undefined)=>void){
 const copyBody=between('function copyNextJsInternalHistoryState(data) {','\nfunction Head(');
 const copy=new Function('window',`${copyBody}; return copyNextJsInternalHistoryState;`)(window);
 const patch=between('window.history.replaceState = function replaceState(data, _unused, url) {','\n        /**');
 new Function('window','originalReplaceState','applyUrlFromHistoryPushReplace','copyNextJsInternalHistoryState',patch)(window,nativeReplace.bind(window.history),onCanonicalUrl,copy);
}
beforeEach(()=>{vi.clearAllMocks();__resetUnsavedGuards();window.history.replaceState=nativeReplace;});
afterEach(()=>{cleanup();__resetUnsavedGuards();window.history.replaceState=nativeReplace;});
it('keeps the visible Attendance tab and router URL together after an independent calendar save with an unrelated draft',async()=>{
 nativeReplace.call(window.history,{__NA:true,__PRIVATE_NEXTJS_INTERNALS_TREE:{fixture:'tree'},appContext:'retain'},'', '/admin/personnel/employee?tab=profile&asOf=2025-04-05&from=retained');
 let canonical=new URL(window.location.href);
 installNextHistory(url=>{canonical=new URL(url??window.location.href,window.location.href);});
 state.save.mockResolvedValue({ok:true,updated:0,reviewDates:[]});
 // Next refresh reuses its canonical URL while retaining mounted client state.
 state.refresh.mockImplementation(()=>nativeReplace.call(window.history,window.history.state,'',canonical));
 const content=()=> <NextIntlClientProvider locale="en" messages={en}><ClientTabs tabs={[{key:'profile',label:'Profile'},{key:'attendance',label:'Attendance'}]} defaultTab="profile" emptyLabel="No records" panels={{
  profile:<p>Profile facts</p>,attendance:<><HolidayCalendarAssignments employmentId="employee" joinDate="2025-04-05" fallbackLabel="Selangor" groups={[]} states={['Johor']} rows={[]}/><TabSaveScope tabKey="attendance" identity={{employmentId:'employee'}} saveAction={vi.fn()} covers={['Web Clocking']}><form data-save-section="attendance-photo"><label>Photo requirement<input name="attendancePhotoSetting" defaultValue="required"/></label></form></TabSaveScope></>,
 }}/></NextIntlClientProvider>;
 const view=render(content());fireEvent.click(screen.getByRole('tab',{name:'Attendance'}));
 fireEvent.change(screen.getByLabelText('Photo requirement'),{target:{value:'optional'}});
 await waitFor(()=>expect(screen.getByRole('button',{name:'Save Changes'})).toBeEnabled());
 fireEvent.click(screen.getByRole('button',{name:'Add calendar'}));fireEvent.change(screen.getByLabelText('Calendar'),{target:{value:'state:Johor'}});
 fireEvent.submit(screen.getByRole('form',{name:'Add calendar'}));await waitFor(()=>expect(state.refresh).toHaveBeenCalledOnce());view.rerender(content());
 expect(screen.getByRole('tab',{name:'Attendance'})).toHaveAttribute('aria-selected','true');
 expect(canonical.searchParams.get('tab')).toBe('attendance');
 const actual=new URL(window.location.href);expect(actual.searchParams.get('tab')).toBe('attendance');expect(actual.searchParams.get('asOf')).toBe('2025-04-05');expect(actual.searchParams.get('from')).toBe('retained');
 expect(window.history.state).toMatchObject({appContext:'retain',__NA:true,__tabSaveUnsavedSentinel:true});
 expect(screen.getByLabelText('Photo requirement')).toHaveValue('optional');expect(screen.getByRole('button',{name:'Save Changes'})).toBeEnabled();expect(screen.queryByRole('dialog')).toBeNull();
});
