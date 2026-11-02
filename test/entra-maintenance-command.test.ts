/** Direct server actions: a rendered/readable settings page is not mutation authority. */
import {beforeEach,expect,it,vi} from 'vitest';
const f=vi.hoisted(()=>({edit:false,require:vi.fn(),connector:vi.fn(),save:vi.fn(),execute:vi.fn(),oidc:vi.fn(),graph:vi.fn()}));
vi.mock('@/lib/scope',()=>({scopedAdmin:async()=>({s:{tenantId:'fictional-tenant',userId:'fictional-user'}})}));
vi.mock('@/lib/entra/store',()=>({
 requireEntraAdmin:async(_ctx:unknown,operation:string)=>{f.require(operation);if(operation!=='edit'||!f.edit)throw Error('EDIT_REFUSED');},
 connector:f.connector,saveConnector:f.save,
}));
vi.mock('@/lib/entra/login',()=>({oidcConfiguration:f.oidc}));
vi.mock('@/lib/entra/graph',()=>({graphToken:f.graph}));
vi.mock('@/db/client',()=>({withTenant:async(_ctx:unknown,run:(tx:unknown)=>Promise<unknown>)=>run({execute:f.execute})}));
vi.mock('next/navigation',()=>({redirect:(url:string)=>{throw Error('REDIRECT:'+url);}}));
import {saveEntra,testEntra,bindEntra,retryEntra,reconcileEntra} from '../app/admin/settings/entra/actions';
beforeEach(()=>{
 vi.clearAllMocks();f.edit=false;
 f.connector.mockResolvedValue({enabled:true,provisioningEnabled:true});
 f.oidc.mockResolvedValue({});f.graph.mockResolvedValue('fictional-token');
});
it.each([
 ['save',()=>saveEntra(new FormData())],['connection test',()=>testEntra()],
 ['bind',()=>bindEntra(new FormData())],['retry',()=>retryEntra(new FormData())],
 ['reconcile',()=>reconcileEntra(new FormData())],
] as const)('refuses direct %s before private configuration, SQL mutation or network work',async(_name,run)=>{
 await expect(run()).rejects.toThrow('EDIT_REFUSED');expect(f.require).toHaveBeenCalledWith('edit');
 for(const effect of [f.connector,f.save,f.execute,f.oidc,f.graph])expect(effect).not.toHaveBeenCalled();
});
it('rechecks current Edit for each connection test and stops outbound work after revocation',async()=>{
 f.edit=true;await expect(testEntra()).rejects.toThrow('REDIRECT:/admin/settings/entra?tested=1');
 expect(f.oidc).toHaveBeenCalledOnce();expect(f.graph).toHaveBeenCalledOnce();
 f.edit=false;await expect(testEntra()).rejects.toThrow('EDIT_REFUSED');
 expect(f.connector).toHaveBeenCalledOnce();expect(f.oidc).toHaveBeenCalledOnce();expect(f.graph).toHaveBeenCalledOnce();
});
