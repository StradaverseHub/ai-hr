import {beforeEach,describe,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({roles:['employee'],notFound:new Error('fixture-not-found')}));
// The admission boundary is already satisfied; this test covers the route segment after admission.
vi.mock('../lib/workforce-authz',()=>({requireWorkforceAccess:async()=>({s:{tenantId:'11111111-1111-1111-1111-111111111111',roles:state.roles},scopeIds:[]})}));
vi.mock('next/navigation',()=>({notFound:()=>{throw state.notFound;},redirect:()=>{throw new Error('Unexpected redirect');},useRouter:()=>({}),usePathname:()=>'/'}));
import Page from '../app/(app)/admin/personnel/[employmentId]/page';
beforeEach(()=>{state.roles=['employee'];});
describe('Personnel malformed pointer after Workforce admission',()=>{
 it.each([['employee'],['hr_admin']])('refuses malformed IDs before either record lane for %s',async role=>{
  state.roles=[role];
  await expect(Page({params:Promise.resolve({employmentId:'not-a-uuid'}),searchParams:Promise.resolve({})})).rejects.toBe(state.notFound);
 });
});
