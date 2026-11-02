/** Real editor with fictional owner data and bounded server-action fixtures. */
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {cleanup,render,screen,fireEvent} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import viCopy from '../messages/vi.json';import ta from '../messages/ta.json';import th from '../messages/th.json';
import {captureAiReviewScreenshots,aiReviewDomHtml} from './helpers/ai-review-screenshots';
import type {DataPermissionState} from '../core/data-permissions';
const actions=vi.hoisted(()=>({preview:vi.fn(),save:vi.fn(),refresh:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:actions.refresh})}));
vi.mock('../app/admin/security-center/data-permissions/actions',()=>({previewDataPermissionAction:actions.preview,saveDataPermissionAction:actions.save}));
import {DataPermissionEditor} from '../app/admin/security-center/data-permissions/editor';
const copies={en,ms,zh,vi:viCopy,ta,th};
const profileId='11111111-1111-1111-1111-111111111111',userId='22222222-2222-2222-2222-222222222222';
const state:DataPermissionState={revision:'fictional-revision',profiles:[{id:profileId,name:'Fictional Company A · Grades A–C',revision:'profile-revision',editable:true,enabled:true,rules:{legacyCompany:false,predicates:[{field:'grade',values:['33333333-3333-3333-3333-333333333333']}]},assignedCount:1}],assignments:[{userId,profileId}],options:[{field:'company',value:'44444444-4444-4444-4444-444444444444',label:'Fictional Company A'},{field:'grade',value:'33333333-3333-3333-3333-333333333333',label:'Fictional Grade A'}]};
function show(locale:keyof typeof copies='en'){render(<NextIntlClientProvider locale={locale} messages={copies[locale]}><DataPermissionEditor state={state} users={[{id:userId,label:'Fictional administrator'}]}/></NextIntlClientProvider>);}
beforeEach(()=>{vi.clearAllMocks();actions.preview.mockResolvedValue({ok:true,value:{fingerprint:'reviewed',affectedUsers:1,matchingRecords:3,beforeRecords:4,afterRecords:3,gainedRecords:0,lostRecords:1}});actions.save.mockResolvedValue({ok:true,value:{revision:'new'}});});
afterEach(cleanup);
describe('data permission configuration and reviewed user assignment',()=>{
 it.each(Object.keys(copies) as (keyof typeof copies)[])('%s renders real full-width condition controls and assignment states',async locale=>{
  show(locale);const t=copies[locale].dataPermissions;
  expect(screen.getByRole('button',{name:t.preview}).hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:/Fictional Company A · Grades A–C/}));
  expect((screen.getByRole('combobox',{name:t.profile}) as HTMLSelectElement).value).toBe(profileId);
  expect(screen.getByRole('button',{name:t.retire}).hasAttribute('disabled')).toBe(true);
  await captureAiReviewScreenshots(aiReviewDomHtml(document.body),locale,'security-data-permissions');
 },60_000);
 it('requires a fresh preview and invalidates it on draft edits',async()=>{
  show();fireEvent.click(screen.getByRole('button',{name:/Fictional Company A · Grades A–C/}));
  fireEvent.click(screen.getByRole('button',{name:en.dataPermissions.preview}));await screen.findByText(en.dataPermissions.review);
  expect(actions.save).not.toHaveBeenCalled();fireEvent.change(screen.getByRole('textbox',{name:en.dataPermissions.name}),{target:{value:'Changed draft'}});
  expect(screen.queryByRole('button',{name:en.dataPermissions.confirm})).toBeNull();
 });
 it('saves the exact reviewed assignment and surfaces a concurrent refusal',async()=>{
  actions.save.mockResolvedValue({ok:false,code:'changed'});show();fireEvent.click(screen.getByRole('button',{name:en.dataPermissions.previewAssignment}));
  fireEvent.click(await screen.findByRole('button',{name:en.dataPermissions.confirm}));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent',en.dataPermissions.errors.changed);
  expect(actions.save).toHaveBeenCalledWith(state.revision,{kind:'assign',userId,profileId},'reviewed');expect(actions.refresh).not.toHaveBeenCalled();
 });
});
