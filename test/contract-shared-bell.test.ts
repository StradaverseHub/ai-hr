import {beforeEach,expect,it,vi} from 'vitest';
import type {SessionContext} from '../db/client';
const source=vi.hoisted(()=>({legacy:vi.fn(),work:vi.fn(),postings:vi.fn(),holds:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('next-intl/server',()=>({getTranslations:async()=>((key:string)=>key)}));
vi.mock('../packs/contracts/service',()=>({contractInbox:source.legacy,contractSharedWorkPage:source.work,contractSharedPostingWorkPage:source.postings}));
vi.mock('../packs/lifecycle/service',()=>({v9EmailHoldInbox:source.holds}));
vi.mock('../core/entitlements',()=>({isModuleEnabledOrFalse:()=>true}));
import {lifecycleModuleInbox} from '../app/lifecycle/module-inbox';
const session={tenantId:'fictional-tenant',userId:'actual-assigned-account',roles:['employee']} as SessionContext;
const navigation:Parameters<typeof lifecycleModuleInbox>[1]={contractStaff:{page:false,configure:false,intake:false,automation:false},probation:{page:false,configure:false,intake:false,access:false}};
beforeEach(()=>{vi.clearAllMocks();source.legacy.mockResolvedValue({count:0,items:[]});source.holds.mockResolvedValue({count:0,items:[]});source.work.mockResolvedValue({items:[],total:0,approvalTotal:0,taskTotal:0});source.postings.mockResolvedValue({items:[],total:0});});
it('sums native owner totals independently of bounded previews for an actor without Case View',async()=>{
 source.work.mockResolvedValue({items:[{id:'assigned-letter',kind:'contractLetter',subjectName:'Fictional employee',action:'sign',linkPath:'/lifecycle/contracts/letters/assigned-letter'}],total:1000,approvalTotal:0,taskTotal:1000});
 source.postings.mockResolvedValue({items:[{id:'assigned-posting',kind:'contractPosting',subjectName:'Fictional employee',linkPath:'/lifecycle/contracts/postings?postingId=assigned-posting'}],total:250});
 const result=await lifecycleModuleInbox(session,navigation);
 expect(source.legacy).not.toHaveBeenCalled();expect(source.work).toHaveBeenCalledWith(session,{limit:20});expect(source.postings).toHaveBeenCalledWith(session,{limit:20});
 expect(result.count).toBe(1250);expect(result.myTasksCount).toBe(1000);expect(result.queueLinks.map(queue=>queue.href)).toEqual(['/tasks?contractPage=1','/lifecycle/contracts/postings/work']);expect(result.items).toHaveLength(2);expect(result.approvalCount).toBe(0);expect(result.items[1].linkPath).toContain('postingId=assigned-posting');
});
it('keeps separate paged My Tasks from rereading Contract previews and counts only actual Approval Items work',async()=>{
 source.work.mockResolvedValue({items:[],total:9,approvalTotal:6,taskTotal:3});
 expect((await lifecycleModuleInbox(session,navigation)).approvalCount).toBe(6);
 vi.clearAllMocks();
 const result=await lifecycleModuleInbox(session,navigation,{includeShared:false});
 expect(source.work).not.toHaveBeenCalled();expect(source.postings).not.toHaveBeenCalled();expect(result.count).toBe(0);
});
