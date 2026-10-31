/** Action transport only. SQL authority is exercised separately by the real restricted-runtime tests. */
import {beforeEach,describe,expect,it,vi} from 'vitest';
const calls=vi.hoisted(()=>({session:vi.fn(),preview:vi.fn(),save:vi.fn(),revalidate:vi.fn(),store:{serverOwned:true}}));
vi.mock('../lib/session',()=>({getSession:calls.session}));
vi.mock('../core/access-configuration',()=>({previewAccessConfiguration:calls.preview,saveAccessConfiguration:calls.save}));
vi.mock('../core/access-configuration-store',()=>({accessConfigurationStore:calls.store}));
vi.mock('next/cache',()=>({revalidatePath:calls.revalidate}));
import {previewAccessConfigurationAction,saveAccessConfigurationAction} from '../app/(app)/admin/users/access/actions';
import {AccessPermissionError} from '../lib/access-permission-model';
const session={tenantId:'fictional-tenant',userId:'real-session-user',roles:['employee']};
const edit={expectedRevision:'current-revision',command:{kind:'renameGroup',groupId:'fictional-id',name:'Fictional group'}};
beforeEach(()=>{vi.resetAllMocks();calls.session.mockResolvedValue(session);calls.preview.mockResolvedValue({revision:'current-revision',fingerprint:'p',changes:[],changesUnrestrictedScope:false});calls.save.mockResolvedValue({revision:'next-revision'});});
describe('server-owned access editor actions',()=>{
 it('uses a fresh session for every call and never a submitted actor or snapshot',async()=>{
  expect((await previewAccessConfigurationAction(edit)).ok).toBe(true);
  expect(calls.preview).toHaveBeenCalledWith(session,expect.objectContaining(edit),calls.store);
  expect(await previewAccessConfigurationAction({...edit,actorUserId:'forged'})).toEqual({ok:false,code:'invalid'});
  expect(await previewAccessConfigurationAction({...edit,snapshot:{roles:['super_admin']}})).toEqual({ok:false,code:'invalid'});
  expect(calls.preview).toHaveBeenCalledTimes(1);expect(calls.session).toHaveBeenCalledTimes(3);
 });
 it('does not report a save or revalidate on a stale/refused transition',async()=>{
  calls.save.mockRejectedValue(new AccessPermissionError('changed'));
  expect(await saveAccessConfigurationAction({...edit,previewFingerprint:'stale'})).toEqual({ok:false,code:'changed'});
  expect(calls.revalidate).not.toHaveBeenCalled();
  calls.save.mockResolvedValueOnce({revision:'next-revision'});
  expect(await saveAccessConfigurationAction({...edit,previewFingerprint:'fresh'})).toEqual({ok:true,value:{revision:'next-revision'}});
  expect(calls.revalidate.mock.calls).toEqual([['/admin/users/access'],['/admin/users']]);
 });
 it('retains authentication failures and refuses malformed transport without touching the owner',async()=>{
  const auth=new Error('Fictional auth required');calls.session.mockRejectedValueOnce(auth);
  await expect(previewAccessConfigurationAction(edit)).rejects.toBe(auth);
  expect(await previewAccessConfigurationAction(null)).toEqual({ok:false,code:'invalid'});
  expect(await saveAccessConfigurationAction({...edit,previewFingerprint:'p',extra:true})).toEqual({ok:false,code:'invalid'});
  expect(calls.preview).not.toHaveBeenCalled();expect(calls.save).not.toHaveBeenCalled();
 });
});
