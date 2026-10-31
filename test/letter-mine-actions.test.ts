import {beforeEach,it,expect,vi} from 'vitest';
import {LetterWorkflowError} from '../lib/letter-workflow';
import {AuthRequiredError} from '../lib/auth-errors';
const mocks=vi.hoisted(()=>({session:vi.fn(),access:vi.fn(),confirm:vi.fn(),download:vi.fn(),revalidate:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:mocks.session}));
vi.mock('../core/letters',()=>({createMyLetterAccess:mocks.access,acknowledgeMyLetter:mocks.confirm,downloadMyLetter:mocks.download}));
vi.mock('next/cache',()=>({revalidatePath:mocks.revalidate}));
vi.mock('next/navigation',()=>({redirect:(url:string)=>{throw new Error('REDIRECT:'+url);}}));
vi.mock('next-intl/server',()=>({getTranslations:async()=>((key:string)=>'Localised '+key)}));
import {openMyLetter,confirmMyLetter} from '../app/(app)/me/letters/actions';
import {GET} from '../app/(app)/me/letters/[letterId]/document/route';
const id='00000000-0000-4000-8000-000000000001',hash='a'.repeat(64),token='B'.repeat(43),ctx={tenantId:'fixture',userId:'verified-user'};
function form(){const data=new FormData();data.set('letterId',id);data.set('artifactHash',hash);data.set('action','acknowledge');data.set('confirm','yes');return data;}
beforeEach(()=>{vi.clearAllMocks();mocks.session.mockResolvedValue(ctx);});
it('creates a sensitive link only after an authenticated open action and delegates ownership to the owner',async()=>{
 mocks.access.mockResolvedValue({token,expiresAt:new Date(),artifactHash:hash});await expect(openMyLetter(form())).rejects.toThrow(`REDIRECT:/me/letters/${id}/document?token=${token}&inline=1`);expect(mocks.access).toHaveBeenCalledExactlyOnceWith(ctx,id);
});
it('requires an explicit confirmation and binds its localized intent and exact artifact hash',async()=>{
 const unchecked=form();unchecked.delete('confirm');await expect(confirmMyLetter(unchecked)).rejects.toThrow('error=invalid');expect(mocks.confirm).not.toHaveBeenCalled();
 mocks.confirm.mockResolvedValue({at:new Date(),alreadyRecorded:false});const confirmed=form();confirmed.set('intent','Forged form text');await expect(confirmMyLetter(confirmed)).rejects.toThrow('notice=recorded');expect(mocks.confirm).toHaveBeenCalledExactlyOnceWith(ctx,{letterId:id,expectedArtifactHash:hash,action:'acknowledge',intent:'Localised acknowledgementIntent'});
});
it('preserves the distinction between a retry and a new confirmation and never discloses internal errors',async()=>{
 mocks.confirm.mockResolvedValue({at:new Date(),alreadyRecorded:true});await expect(confirmMyLetter(form())).rejects.toThrow('notice=alreadyRecorded');mocks.access.mockRejectedValue(new Error('private SQL diagnostic'));await expect(openMyLetter(form())).rejects.toThrow('error=unavailable');
 mocks.confirm.mockRejectedValue(new LetterWorkflowError('stale'));await expect(confirmMyLetter(form())).rejects.toThrow('error=stale');
});
it('serves only the freshly authorised exact bytes with private no-store headers',async()=>{
 mocks.download.mockResolvedValue({content:Buffer.from('%PDF-fictional'),fileName:'HR_2026_1.pdf',contentHash:hash});const response=await GET(new Request(`https://fixture.test/me/letters/${id}/document?token=${token}&inline=1`),{params:Promise.resolve({letterId:id})});expect(mocks.download).toHaveBeenCalledExactlyOnceWith(ctx,{letterId:id,token});expect(await response.text()).toBe('%PDF-fictional');expect(response.headers.get('cache-control')).toBe('private, no-store');expect(response.headers.get('referrer-policy')).toBe('no-referrer');expect(response.headers.get('content-disposition')).toContain('inline;');
});
it('conceals foreign, revoked and expired documents and refuses missing identities',async()=>{
 for(const code of ['permission','state'] as const){mocks.download.mockRejectedValue(new LetterWorkflowError(code));const response=await GET(new Request('https://fixture.test/'),{params:Promise.resolve({letterId:id})});expect(response.status).toBe(404);expect(await response.text()).toBe('');expect(response.headers.get('cache-control')).toContain('no-store');}
 mocks.session.mockRejectedValue(new AuthRequiredError());expect((await GET(new Request('https://fixture.test/'),{params:Promise.resolve({letterId:id})})).status).toBe(401);
});
