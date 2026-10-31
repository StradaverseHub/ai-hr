/** Authored UNRUN. Command composition only; framework POST/Origin and DB authority need experience/security execution. */
import {beforeEach,describe,expect,it,vi} from 'vitest';
const source=vi.hoisted(()=>({session:vi.fn(),record:vi.fn(),reopen:vi.fn(),erase:vi.fn(),workspace:vi.fn(),notification:vi.fn(),revalidate:vi.fn()}));
vi.mock('next/navigation',()=>({redirect:(url:string):never=>{throw Error('REDIRECT '+url);}}));
vi.mock('next/cache',()=>({revalidatePath:source.revalidate}));
vi.mock('../lib/session',()=>({getBrowserCommandSession:source.session}));
vi.mock('../core/module-native-outcomes',()=>({recordOwnNativeOutcomeAssociation:source.record,reopenOwnNativeOutcomeAssociation:source.reopen,eraseOwnNativeOutcomeAssociations:source.erase}));
vi.mock('../core/module-native-outcome-workspace',()=>({loadOwnNativeOutcomeWorkspace:source.workspace}));
vi.mock('../core/assistant-actions/own-notification-preferences-source',()=>({resolveOwnNotificationServerIdentity:source.notification}));
import {recordNativeOutcomeAction,reopenNativeOutcomeAction,eraseNativeOutcomesAction} from '../app/(app)/assistant/native-outcome-actions';
const job='10000000-0000-4000-8000-000000000001',actionId='10000000-0000-4000-8000-000000000002',nonce='10000000-0000-4000-8000-000000000003',associationId='10000000-0000-4000-8000-000000000004';
const session=()=>({tenantId:job,userId:actionId,personId:nonce,roles:['employee'],grants:[{role:'employee',companyId:null as string|null}]});
const reference={source:'review' as const,action:'leave.apply' as const,actionId};
const view=(action='leave.apply')=>({associationId,action,module:'leave',semantics:'submitted_not_approved',currentStatus:null,association:'human_linked_verified_native_outcome',causalCredit:false,quality:'not_assessed',createdAt:'2026-01-01T00:00:00.000Z',expiresAt:'2026-01-02T00:00:00.000Z'});
function form(){const f=new FormData();f.set('jobId',job);f.set('reference',JSON.stringify(reference));f.set('nonce',nonce);f.set('consented','yes');return f;}
beforeEach(()=>{vi.clearAllMocks();source.session.mockResolvedValue(session());source.record.mockResolvedValue(view());source.reopen.mockResolvedValue(view());source.erase.mockResolvedValue({erased:true});source.workspace.mockResolvedValue({jobId:job,choices:[],links:[{associationId,action:'leave.apply',createdAt:'2026-01-01'}],truncated:false});source.notification.mockResolvedValue({opaque:'server-only'});});
describe('explicit own native outcome browser commands',()=>{
 it('captures confirmation fields before authentication awaits and accepts no posted identity or native facts',async()=>{
  const f=form(),expected={jobId:job,reference,nonce,consented:true};
  source.session.mockImplementationOnce(async()=>{f.set('jobId',actionId);f.set('reference','{"eventId":"posted-forgery"}');f.set('consented','no');return session();});
  await expect(recordNativeOutcomeAction(f)).rejects.toThrow('nativeOutcome=saved');
  expect(source.record).toHaveBeenCalledExactlyOnceWith(session(),expected,{});expect(source.notification).not.toHaveBeenCalled();expect(source.revalidate).toHaveBeenCalledWith('/assistant');
 });
 it.each(['no','',undefined])('refuses missing or unchecked consent %s without authenticating or calling the source',async(consent)=>{
  const f=form();if(consent===undefined)f.delete('consented');else f.set('consented',consent);
  await expect(recordNativeOutcomeAction(f)).rejects.toThrow('nativeOutcome=unavailable');expect(source.session).not.toHaveBeenCalled();expect(source.record).not.toHaveBeenCalled();
 });
 it.each(['{"source":"review","action":"leave.apply","actionId":"bad"}','{"source":"review","action":"leave.apply","actionId":"'+actionId+'","eventId":"'+job+'"}','x'.repeat(513)])('refuses malformed, extended or oversized references before source access',async(raw)=>{
  const f=form();f.set('reference',raw);await expect(recordNativeOutcomeAction(f)).rejects.toThrow('nativeOutcome=unavailable');expect(source.record).not.toHaveBeenCalled();expect(source.session).not.toHaveBeenCalled();
 });
 it('uses opaque notification identity only from server resolution and snapshots session before that await',async()=>{
  const retained=session(),expected=structuredClone(retained),f=form();f.set('reference',JSON.stringify({...reference,action:'notifications.email_preferences.save'}));f.set('notificationIdentity','posted identity');
  source.session.mockResolvedValueOnce(retained);source.record.mockResolvedValueOnce(view('notifications.email_preferences.save'));
  source.notification.mockImplementationOnce(async()=>{retained.userId=job;retained.roles.push('super_admin');retained.grants[0].companyId=job;return {opaque:'server-only'};});
  await expect(recordNativeOutcomeAction(f)).rejects.toThrow('nativeOutcome=saved');expect(source.record).toHaveBeenCalledWith(expected,{jobId:job,reference:{...reference,action:'notifications.email_preferences.save'},nonce,consented:true},{notificationIdentity:{opaque:'server-only'}});
 });
 it('never redirects raw database/provider details, and does not invalidate caches on refused record',async()=>{
  source.record.mockRejectedValueOnce(Error('PRIVATE SQLSTATE salary/person'));await expect(recordNativeOutcomeAction(form())).rejects.toThrow('REDIRECT /assistant?governed='+job+'&nativeOutcome=unavailable');expect(source.revalidate).not.toHaveBeenCalled();
 });
 it('reopens only a selected own job link and never calls native confirmation or execution',async()=>{
  const f=new FormData();f.set('jobId',job);f.set('associationId',associationId);await expect(reopenNativeOutcomeAction(f)).rejects.toThrow('nativeOutcome=checked&nativeLink='+associationId);expect(source.reopen).toHaveBeenCalledExactlyOnceWith(session(),{associationId},{});expect(source.record).not.toHaveBeenCalled();
  source.workspace.mockResolvedValueOnce({jobId:job,choices:[],links:[],truncated:false});await expect(reopenNativeOutcomeAction(f)).rejects.toThrow('nativeOutcome=unavailable');expect(source.reopen).toHaveBeenCalledTimes(1);
 });
 it('keeps erasure identity-only after grants are gone without a job lookup or posted target',async()=>{
  source.session.mockResolvedValueOnce({...session(),roles:[],grants:[],personId:null});await expect(eraseNativeOutcomesAction()).rejects.toThrow('nativeOutcome=erased');expect(source.erase).toHaveBeenCalledWith({...session(),roles:[],grants:[],personId:null});expect(source.workspace).not.toHaveBeenCalled();expect(source.notification).not.toHaveBeenCalled();
 });
});
