import {beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({decline:vi.fn(),revalidate:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:async()=>({tenantId:'fixture',userId:'actual-user'})}));
vi.mock('../core/letter-requests',async load=>({...await load<typeof import('../core/letter-requests')>(),declineLetterRequest:mocks.decline}));
vi.mock('next/cache',()=>({revalidatePath:mocks.revalidate}));
vi.mock('next/navigation',()=>({redirect:(url:string)=>{throw new Error('REDIRECT:'+url);}}));
import {LetterRequestError} from '../core/letter-requests';
import {declineLetterRequestAction} from '../app/letters/generate/actions';
const companyId='00000000-0000-4000-8000-000000000001',requestId='00000000-0000-4000-8000-000000000002';
function form(extra:Record<string,string>={}){const f=new FormData();for(const [key,value] of Object.entries({companyId,requestId,expectedVersion:'7',reason:'Private HR reason',employeeMessage:'Employee message',...extra}))f.set(key,value);return f;}
beforeEach(()=>{vi.clearAllMocks();mocks.decline.mockResolvedValue(undefined);});
it('retains the displayed page and all-company mode without changing the reviewed native command',async()=>{
 await expect(declineLetterRequestAction(form({requests:'all',requestPage:'3',requestSize:'50'}))).rejects.toThrow(`REDIRECT:/letters/generate?companyId=${companyId}&requests=all&requestPage=3&requestSize=50&requestNotice=declined#letter-requests`);
 expect(mocks.decline).toHaveBeenCalledExactlyOnceWith({tenantId:'fixture',userId:'actual-user'},{requestId,expectedVersion:7,reason:'Private HR reason',employeeMessage:'Employee message'});
 expect(mocks.revalidate).toHaveBeenCalledExactlyOnceWith('/letters/generate');
});
it('retains page context on stale refusal without leaking private text or revalidating',async()=>{
 mocks.decline.mockRejectedValue(new LetterRequestError('stale'));
 await expect(declineLetterRequestAction(form({requestPage:'2',requestSize:'200'}))).rejects.toThrow(`REDIRECT:/letters/generate?companyId=${companyId}&requestPage=2&requestSize=200&requestError=stale#letter-requests`);expect(mocks.revalidate).not.toHaveBeenCalled();
});
it('normalizes tampered paging and preserves the previous redirect for older forms',async()=>{
 await expect(declineLetterRequestAction(form({requestPage:'-3',requestSize:'999'}))).rejects.toThrow(`REDIRECT:/letters/generate?companyId=${companyId}&requestSize=25&requestNotice=declined#letter-requests`);
 await expect(declineLetterRequestAction(form())).rejects.toThrow(`REDIRECT:/letters/generate?companyId=${companyId}&requestNotice=declined#letter-requests`);
});
