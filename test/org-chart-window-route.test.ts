import {beforeEach,expect,it,vi} from 'vitest';
const f=vi.hoisted(()=>({session:vi.fn(),read:vi.fn()}));
vi.mock('../lib/personnel-import-browser-key',()=>({personnelImportBrowserKey:()=> 'current'}));
vi.mock('../lib/scope',()=>({scopedSession:f.session}));
vi.mock('../core/org-chart-window',()=>({orgChartWindow:f.read,OrgWindowUnavailableError:class extends Error{constructor(public reason:string){super(reason);}}}));
import {GET} from '../app/api/org/window/route';
import {OrgWindowUnavailableError} from '../core/org-chart-window';
import {AuthRequiredError} from '../lib/auth-errors';
beforeEach(()=>{vi.clearAllMocks();f.session.mockResolvedValue({s:{userId:'actual'},scopeIds:['authorized']});f.read.mockResolvedValue({items:[]});});
it('uses only fresh server scope and disables transport caching',async()=>{
 const response=await GET(new Request('https://example.test/api/org/window?view=search&q=literal%25_'));
 expect(f.session).toHaveBeenCalledOnce();expect(f.read).toHaveBeenCalledWith({userId:'actual'},['authorized'],{view:'search',q:'literal%_'});
 expect(response.status).toBe(200);expect(await response.json()).toEqual({items:[],browserKey:'current'});expect(response.headers.get('Cache-Control')).toBe('private, no-store');expect(response.headers.get('Vary')).toBe('Cookie, Authorization');
});
it('refuses duplicate parameters and client-provided company scopes',async()=>{
 for(const query of ['view=roots&view=search','companyIds=foreign','scope=other'])expect((await GET(new Request(`https://example.test/?${query}`))).status).toBe(400);
 expect(f.session).not.toHaveBeenCalled();expect(f.read).not.toHaveBeenCalled();
});
it('separates lost access, stale cursor, missing focus and infrastructure errors from empty results',async()=>{
 for(const [error,status,body] of [[new AuthRequiredError(),401,'authentication_required'],[new OrgWindowUnavailableError('principal'),403,'principal'],[new OrgWindowUnavailableError('focus'),404,'focus'],[new OrgWindowUnavailableError('cursor'),409,'cursor'],[new RangeError('private detail'),400,'invalid_window'],[new Error('private detail'),503,'unavailable']] as const){
  f.read.mockRejectedValueOnce(error);const response=await GET(new Request('https://example.test/'));expect(response.status).toBe(status);expect(await response.json()).toEqual({error:body});
 }
});
