import {beforeEach,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({admin:vi.fn(),scope:vi.fn(),team:vi.fn(),page:vi.fn(),ids:vi.fn(),window:vi.fn()}));
const company='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002';
vi.mock('../lib/scope',()=>({scopedAdmin:state.admin,getScopeIds:state.scope}));
vi.mock('../core/read',()=>({allowedCompanies:async()=>[{id:company,name:'Current company'}]}));
vi.mock('../app/roster/my-team-scope',()=>({rosterTeamContext:state.team,rosterTeamWindow:vi.fn()}));
vi.mock('../core/roster-presentation',()=>({rosterEmployeePage:state.page,rosterPopulationIds:state.ids}));
vi.mock('../core/roster',()=>({rosterWindowView:state.window}));
import {GET as choices} from '../app/roster/employee-choices/route';
import {GET as template} from '../app/roster/template/route';
beforeEach(()=>{
 vi.clearAllMocks();state.admin.mockResolvedValue({s:{tenantId:company,userId:other,roles:['hr_admin']},scopeIds:[company]});state.scope.mockResolvedValue([company]);state.team.mockResolvedValue(null);
 state.page.mockResolvedValue({rows:[],total:0,offset:0,limit:25,businessUnitOptions:[],departmentOptions:[]});state.ids.mockResolvedValue(Array.from({length:201},(_,i)=>'employee-'+i));
 state.window.mockResolvedValue({dates:['2027-01-04'],employees:Array.from({length:201},(_,i)=>({employmentId:'e'+i,name:'Employee '+i,code:'R'+i,department:'Operations',occupation:'Executive'})),cells:{'e200|2027-01-04':{kind:'shift',shiftId:'pg'}},shifts:[{id:'pg',code:'PG',name:'Page shift'}]});
});
it('derives scope freshly and ignores posted membership/cutoff/capacity overrides',async()=>{
 const result=await choices(new Request(`https://example.invalid/roster/employee-choices?companyId=${company}&employmentIds=${other}&terminatedAfter=1900-01-01&limit=50000&offset=25`));
 expect(result.status).toBe(200);expect(result.headers.get('Cache-Control')).toBe('private, no-store');
 const [,input]=state.page.mock.calls[0];expect(input).toEqual({companyIds:[company],businessUnitId:undefined,departmentId:undefined,q:undefined,offset:25,limit:25});
});
it('resolves complete minimal IDs explicitly and never clips them to a result page',async()=>{
 const result=await choices(new Request(`https://example.invalid/roster/employee-choices?companyId=${company}&complete=1&page=8`));
 expect((await result.json()).ids).toHaveLength(201);expect(state.page).not.toHaveBeenCalled();expect(state.ids).toHaveBeenCalledTimes(1);
});
it('refuses foreign company scope before any population read',async()=>{
 const result=await choices(new Request(`https://example.invalid/roster/employee-choices?companyId=${other}`));expect(result.status).toBe(403);expect(state.page).not.toHaveBeenCalled();expect(state.ids).not.toHaveBeenCalled();
});
it('refuses invalid offsets before any population read',async()=>{
 const result=await choices(new Request(`https://example.invalid/roster/employee-choices?companyId=${company}&offset=1e100`));expect(result.status).toBe(400);expect(state.page).not.toHaveBeenCalled();
});
it('builds the complete explicit-demand template even when the screen address names a later page',async()=>{
 const result=await template(new Request(`https://example.invalid/roster/template?companyId=${company}&view=custom&from=2027-01-04&to=2027-01-04&page=8&size=25`));
 const payload=await result.json();expect(payload.rows).toHaveLength(201);expect(payload.rows[200]).toEqual(['R200','Employee 200','Operations','Executive','PG']);
 expect(state.window.mock.calls[0][1]).toMatchObject({companyIds:[company],from:'2027-01-04',to:'2027-01-04'});expect(state.window.mock.calls[0][1]).not.toHaveProperty('limit');expect(state.page).not.toHaveBeenCalled();
});
it('uses freshly resolved team IDs instead of URL membership claims',async()=>{
 state.team.mockResolvedValue({scope:{companyIds:[company],employmentIds:[other]}});
 await choices(new Request(`https://example.invalid/roster/employee-choices?companyId=${company}&employmentIds=forged`));
 expect(state.page.mock.calls[0][1].employmentIds).toEqual([other]);
});
