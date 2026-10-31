import {beforeEach,describe,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({getSession:vi.fn(),acknowledge:vi.fn(),revalidate:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:mocks.getSession}));
vi.mock('../core/read',()=>({myEmployment:vi.fn()}));
vi.mock('../core/notice',()=>({acknowledgeNotice:mocks.acknowledge,NoticeError:class NoticeError extends Error{},dismissNoticePopup:vi.fn(),markNoticeViewed:vi.fn()}));
vi.mock('next/cache',()=>({revalidatePath:mocks.revalidate}));
vi.mock('next/headers',()=>({headers:async()=>new Headers({'user-agent':'Fictional browser'})}));
vi.mock('next/navigation',()=>({unstable_rethrow:vi.fn()}));
import {acknowledgeNoticeAction} from '../app/(app)/notices/actions';
const form=()=>{const f=new FormData();f.set('noticeId','notice');f.set('employmentId','selected-own-employment');f.set('contentVersion','2');return f;};
beforeEach(()=>{vi.clearAllMocks();mocks.getSession.mockResolvedValue({tenantId:'tenant',userId:'actual-user'});mocks.acknowledge.mockResolvedValue({id:'receipt',contentVersion:2,acknowledgedAt:new Date('2026-10-21T12:00:00Z')});});
describe('Notice acknowledgement server boundary',()=>{
 it('passes the selected employment to the real writer without choosing a different employment',async()=>{
  expect(await acknowledgeNoticeAction({},form())).toEqual({acknowledgedAt:'2026-10-21T12:00:00.000Z'});
  expect(mocks.acknowledge).toHaveBeenCalledWith({tenantId:'tenant',userId:'actual-user'},'notice','selected-own-employment',2,{reportedChannel:'web',reportedUserAgent:'Fictional browser'});
  expect(mocks.revalidate).toHaveBeenCalledWith('/notices/notice');
  expect(mocks.revalidate).toHaveBeenCalledWith('/tasks');
 });
 it('refuses duplicate identity/version fields and maps database refusals without leaking their text',async()=>{
  const f=form();f.append('contentVersion','3');expect(await acknowledgeNoticeAction({},f)).toEqual({error:'unavailable'});expect(mocks.acknowledge).not.toHaveBeenCalled();
  mocks.acknowledge.mockRejectedValue({cause:{code:'23514',message:'PRIVATE SQL TEXT'}});expect(await acknowledgeNoticeAction({},form())).toEqual({error:'changed'});
  mocks.acknowledge.mockRejectedValue({cause:{code:'42501',message:'PRIVATE IDENTIFIER'}});expect(await acknowledgeNoticeAction({},form())).toEqual({error:'unavailable'});
  mocks.acknowledge.mockRejectedValue(new Error('PRIVATE DATABASE DETAIL'));expect(await acknowledgeNoticeAction({},form())).toEqual({error:'failed'});
 });
});
