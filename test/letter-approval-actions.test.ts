import {beforeEach,it,expect,vi} from 'vitest';
import {LetterWorkflowError} from '../lib/letter-workflow';
const mocks=vi.hoisted(()=>({session:vi.fn(),decide:vi.fn(),delegate:vi.fn(),bulk:vi.fn(),revalidate:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:mocks.session}));
vi.mock('../core/letters',()=>({decideLetter:mocks.decide,delegateLetterApproval:mocks.delegate,bulkDecideLetters:mocks.bulk}));
vi.mock('next/cache',()=>({revalidatePath:mocks.revalidate}));
vi.mock('next/navigation',()=>({redirect:(url:string)=>{throw new Error('REDIRECT:'+url);}}));
import {decideApproval,delegateApproval,bulkApprove} from '../app/(app)/letters/approval/actions';
const letterId='00000000-0000-4000-8000-000000000001',revisionId='00000000-0000-4000-8000-000000000002',otherId='00000000-0000-4000-8000-000000000003',ctx={tenantId:'fictional-tenant',userId:'current-user'},head={letterId,expectedRevisionId:revisionId,expectedLockVersion:4};
function form(){const data=new FormData();for(const [key,value]of Object.entries({...head,decision:'approve',comment:'Reviewed this revision',delegateUserId:otherId}))data.set(key,String(value));return data;}
beforeEach(()=>{vi.clearAllMocks();mocks.session.mockResolvedValue(ctx);for(const fn of [mocks.decide,mocks.delegate,mocks.bulk])fn.mockResolvedValue({});});
it('keeps the reviewed witness and explicit signing intent when the owner reports stale content',async()=>{
 const data=form();data.set('confirmSignature','true');mocks.decide.mockRejectedValue(new LetterWorkflowError('stale'));
 expect(await decideApproval(null,data)).toEqual({error:'stale'});expect(mocks.decide).toHaveBeenCalledExactlyOnceWith(ctx,{...head,decision:{action:'approve',comment:'Reviewed this revision',confirmSignature:false}});expect(mocks.revalidate).not.toHaveBeenCalled();
 data.set('confirmSignature','yes');await decideApproval(null,data);expect(mocks.decide.mock.calls.at(-1)?.[1].decision.confirmSignature).toBe(true);
});
it('rejects malformed or duplicate bulk witnesses before exercising authority',async()=>{
 for(const selection of ['{',JSON.stringify([]),JSON.stringify([head,head]),JSON.stringify([{...head,expectedLockVersion:0}]),JSON.stringify([{...head,employeeId:otherId}]),JSON.stringify(Array.from({length:101},()=>head))]){const data=form();data.set('selection',selection);expect(await bulkApprove(null,data)).toEqual({error:'invalid'});}
 expect(mocks.session).not.toHaveBeenCalled();expect(mocks.bulk).not.toHaveBeenCalled();expect(mocks.decide).not.toHaveBeenCalled();
});
it('uses the atomic bulk owner once and never falls back to partial individual approvals',async()=>{
 const data=form(),selection=[head,{...head,letterId:otherId}];data.set('selection',JSON.stringify(selection));data.set('confirmSignature','yes');mocks.bulk.mockRejectedValue(new LetterWorkflowError('permission'));
 expect(await bulkApprove(null,data)).toEqual({error:'permission'});expect(mocks.bulk).toHaveBeenCalledExactlyOnceWith(ctx,{letters:selection,decision:{action:'approve',comment:'Reviewed this revision',confirmSignature:true}});expect(mocks.decide).not.toHaveBeenCalled();expect(mocks.revalidate).not.toHaveBeenCalled();
});
it('does not expose private failures or signal success when delegation is refused',async()=>{
 const data=form();mocks.delegate.mockRejectedValue(new Error('PRIVATE SQL AND RECIPIENT DATA'));expect(await delegateApproval(null,data)).toEqual({error:'unavailable'});expect(mocks.revalidate).not.toHaveBeenCalled();
 mocks.delegate.mockRejectedValue(new LetterWorkflowError('reasonRequired'));data.set('comment','');expect(await delegateApproval(null,data)).toEqual({error:'reasonRequired'});expect(mocks.revalidate).not.toHaveBeenCalled();
});
it('refreshes the workspace only after an accepted decision',async()=>{
 await expect(decideApproval(null,form())).rejects.toThrow('REDIRECT:/letters/approval/'+letterId+'?notice=decided');expect(mocks.revalidate).toHaveBeenCalledWith('/letters/approval');
});
