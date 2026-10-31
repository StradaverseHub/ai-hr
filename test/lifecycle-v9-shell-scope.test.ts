import {expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({cookie:undefined as string|undefined,allowed:[{id:'alpha',name:'Alpha'},{id:'beta',name:'Beta'}]}));
vi.mock('server-only',()=>({}));
vi.mock('next/headers',()=>({cookies:async()=>({get:()=>state.cookie===undefined?undefined:{value:state.cookie}})}));
vi.mock('../lib/session',()=>({getSession:vi.fn()}));
vi.mock('../lib/authz',()=>({requireAdmin:vi.fn()}));
vi.mock('../core/read',()=>({allowedCompanies:async()=>state.allowed}));
vi.mock('../lib/viewer',()=>({viewerIdentity:async()=>({name:'Fictional HR'})}));
vi.mock('../packs/lifecycle/service',()=>({v9Workspace:async()=>({config:null}),onboardingContext:async()=>({revision:0}),onboardingList:vi.fn(),onboardingOptions:vi.fn()}));
import {readV9Workspace} from '../app/lifecycle/v9/read-workspace';
import type {SessionContext} from '../db/client';
it('derives V9 presentation scope from the same allowed/cookie intersection as the AIHR header',async()=>{
 const session={tenantId:'fictional',userId:'fictional-hr',roles:[]} as unknown as SessionContext;
 for(const [cookie,expected] of [[undefined,['alpha','beta']],['beta',['beta']],['foreign,beta',['beta']],['foreign',['alpha','beta']],['',['alpha','beta']]] as const){state.cookie=cookie;expect((await readV9Workspace(session)).companyScope).toEqual(expected);}
 state.allowed=[];state.cookie='foreign';expect((await readV9Workspace(session)).companyScope).toEqual([]);
});
