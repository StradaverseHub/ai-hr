import {beforeEach,it,expect,vi} from 'vitest';
const m=vi.hoisted(()=>({session:vi.fn(),provider:vi.fn(),save:vi.fn(),revalidate:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:m.session}));
vi.mock('../lib/identity/provider',()=>({currentProviderSession:m.provider}));
vi.mock('../core/letter-email-preferences',()=>({saveLetterEmailPreferences:m.save}));
vi.mock('../core/notification-email',()=>({saveNotificationEmailPreferences:vi.fn()}));
vi.mock('next/cache',()=>({revalidatePath:m.revalidate}));
vi.mock('next/navigation',()=>({redirect:(url:string)=>{throw Error('REDIRECT '+url);}}));
import {saveMyLetterEmailPreferences} from '../app/(app)/me/notifications/actions';
const session={tenantId:'fixture',userId:'account-only-reviewer'},identity={issuer:'https://identity.fixture.test',subject:'verified-user',email:'verified@fixture.test',emailVerified:true};
function form(enabled=true){const value=new FormData();value.set('locale','en');if(enabled)value.set('enabled','true');return value;}
beforeEach(()=>{vi.clearAllMocks();m.session.mockResolvedValue(session);m.provider.mockResolvedValue(identity);m.save.mockResolvedValue(undefined);});
it('takes recipient and proof from the current server session, without requiring employment',async()=>{
 const data=form();data.set('recipientUserId','forged-user');data.set('email','forged@fixture.test');data.set('issuer','forged-issuer');data.set('employmentId','forged-employment');await expect(saveMyLetterEmailPreferences(data)).rejects.toThrow('saved=1');
 expect(m.save).toHaveBeenCalledExactlyOnceWith(session,{enabled:true,locale:'en'},identity);expect(m.revalidate).toHaveBeenCalledWith('/me/notifications');
});
it('allows withdrawal with no provider proof and leaves the current binding check to the consent owner',async()=>{
 m.provider.mockRejectedValue(Error('private provider outage'));await expect(saveMyLetterEmailPreferences(form(false))).rejects.toThrow('saved=1');expect(m.save).toHaveBeenCalledExactlyOnceWith(session,{enabled:false,locale:'en'},null);
});
it.each(['duplicate-locale','duplicate-enabled','invalid-enabled','invalid-locale'])('rejects %s before asking for identity or mutating consent',async kind=>{
 const data=form();if(kind==='duplicate-locale')data.append('locale','ms');if(kind==='duplicate-enabled')data.append('enabled','true');if(kind==='invalid-enabled')data.set('enabled','yes');if(kind==='invalid-locale')data.set('locale','xx');
 await expect(saveMyLetterEmailPreferences(data)).rejects.toThrow('error=save');expect(m.provider).not.toHaveBeenCalled();expect(m.save).not.toHaveBeenCalled();expect(m.revalidate).not.toHaveBeenCalled();
});
it('does not invent proof or expose private consent failures',async()=>{
 m.provider.mockResolvedValue({...identity,emailVerified:false});m.save.mockRejectedValue(Error('PRIVATE DATABASE AND IDENTITY DETAILS'));await expect(saveMyLetterEmailPreferences(form())).rejects.toThrow('REDIRECT /me/notifications?error=save');expect(m.save).toHaveBeenCalledWith(session,{enabled:true,locale:'en'},null);expect(m.revalidate).not.toHaveBeenCalled();
});
it('requires a current session before any consent mutation',async()=>{
 m.session.mockRejectedValue(Error('session expired'));await expect(saveMyLetterEmailPreferences(form())).rejects.toThrow('session expired');expect(m.provider).not.toHaveBeenCalled();expect(m.save).not.toHaveBeenCalled();
});
