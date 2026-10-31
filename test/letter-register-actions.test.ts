import {beforeEach,it,expect,vi} from 'vitest';
import {LetterWorkflowError} from '../lib/letter-workflow';
const mocks=vi.hoisted(()=>({session:vi.fn(),issue:vi.fn(),void:vi.fn(),retention:vi.fn(),revalidate:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:mocks.session}));
vi.mock('../core/letters',()=>({issueLetter:mocks.issue,voidLetter:mocks.void,setLetterRetention:mocks.retention}));
vi.mock('next/cache',()=>({revalidatePath:mocks.revalidate}));
vi.mock('next/navigation',()=>({redirect:(url:string)=>{throw new Error('REDIRECT:'+url);}}));
import {updateRegister} from '../app/(app)/letters/register/actions';
const letterId='00000000-0000-4000-8000-000000000001',revisionId='00000000-0000-4000-8000-000000000002',ctx={tenantId:'fixture',userId:'actual-user'};
function form(action='issue'){const data=new FormData();for(const [key,value] of Object.entries({action,letterId,expectedRevisionId:revisionId,expectedLockVersion:'7',confirm:'yes',reason:'Recorded reason',retainUntil:'2030-01-01'}))data.set(key,value);return data;}
beforeEach(()=>{vi.clearAllMocks();mocks.session.mockResolvedValue(ctx);for(const fn of [mocks.issue,mocks.void,mocks.retention])fn.mockResolvedValue({});});
it('requires explicit issuance and void confirmation before entering the owner',async()=>{
 for(const action of ['issue','void']){const data=form(action);data.delete('confirm');expect(await updateRegister(null,data)).toEqual({error:'invalid'});}expect(mocks.session).not.toHaveBeenCalled();expect(mocks.issue).not.toHaveBeenCalled();expect(mocks.void).not.toHaveBeenCalled();
});
it('preserves the reviewed sealed revision and lock when issuance is stale',async()=>{
 mocks.issue.mockRejectedValue(new LetterWorkflowError('stale'));expect(await updateRegister(null,form())).toEqual({error:'stale'});expect(mocks.issue).toHaveBeenCalledExactlyOnceWith(ctx,{letterId,expectedRevisionId:revisionId,expectedLockVersion:7});expect(mocks.revalidate).not.toHaveBeenCalled();
});
it('keeps legal hold and the retained date in the retention owner rather than rewriting the artifact',async()=>{
 const data=form('retention');data.set('legalHold','yes');await expect(updateRegister(null,data)).rejects.toThrow('REDIRECT:/letters/register/'+letterId+'?notice=saved');expect(mocks.retention).toHaveBeenCalledExactlyOnceWith(ctx,{letterId,expectedLockVersion:7,legalHold:true,retainUntil:'2030-01-01',reason:'Recorded reason'});expect(mocks.issue).not.toHaveBeenCalled();expect(mocks.void).not.toHaveBeenCalled();
});
it('does not report success or expose internal details when revocation fails',async()=>{
 mocks.void.mockRejectedValue(new Error('PRIVATE SQL DETAIL'));expect(await updateRegister(null,form('void'))).toEqual({error:'unavailable'});expect(mocks.revalidate).not.toHaveBeenCalled();mocks.void.mockRejectedValue(new LetterWorkflowError('state'));expect(await updateRegister(null,form('void'))).toEqual({error:'state'});
});
