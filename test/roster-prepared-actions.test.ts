import {beforeEach,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({ids:[] as string[],copy:vi.fn(),generate:vi.fn(),targets:vi.fn(),scope:vi.fn(),department:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:async()=>({tenantId:'tenant',userId:'user',roles:['hr_admin']})}));
vi.mock('../lib/authz',()=>({isAdmin:()=>true}));
vi.mock('next/cache',()=>({revalidatePath:vi.fn()}));
vi.mock('next/navigation',()=>({redirect:(href:string)=>{throw new Error('REDIRECT '+href);}}));
vi.mock('../core/roster',()=>({copyRoster:state.copy,generateRosterFromTemplate:state.generate,assertRosterAdmin:vi.fn(),assertRosterDatesWritable:vi.fn(),assignRosterRow:vi.fn(),assignShift:vi.fn(),assignShiftBulk:vi.fn(),clearRoster:vi.fn(),setRestDay:vi.fn(),RosterAdminRequiredError:Error}));
vi.mock('../core/toil',()=>({accrueToil:vi.fn(),ToilFirstScheduleConsentRequiredError:Error}));
vi.mock('../core/roster-presentation',()=>({rosterPopulationIds:state.targets,rosterDepartmentIds:state.department}));
vi.mock('../app/roster/population-scope',()=>({rosterPopulationScope:state.scope}));
import {copyRosterAction,generateRosterAction} from '../app/roster/actions';
const id=(n:number)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
beforeEach(()=>{vi.clearAllMocks();state.ids=[id(1),id(2)];state.scope.mockResolvedValue({companyIds:[id(900)]});state.targets.mockImplementation(async(_s,p)=>p.employmentIds.filter((id:string)=>state.ids.includes(id)));state.department.mockImplementation(async()=>state.ids);state.copy.mockResolvedValue({copied:2,sourceRows:2});state.generate.mockResolvedValue({employments:2,workingRows:2,restRows:0});});
function form(ids:unknown){const data=new FormData();data.set('companyId',id(900));data.set('selectionRequired','1');if(ids!==undefined)data.set('selectionIds',JSON.stringify(ids));data.set('sourceFrom','2027-01-04');data.set('sourceTo','2027-01-05');data.set('targetFrom','2027-02-01');data.set('from','2027-02-01');data.set('to','2027-02-02');data.set('shiftId',id(800));return data;}
it('copies the complete reviewed set beyond a page, with no later arrivals added',async()=>{
 const selected=Array.from({length:201},(_,i)=>id(i));state.ids=[...selected,id(999)];
 await expect(copyRosterAction(form(selected))).rejects.toThrow('copied=2');
 expect(state.copy.mock.calls[0][1].employmentIds).toEqual(selected);expect(state.targets.mock.calls[0][1].employmentIds).toEqual(selected);expect(state.copy.mock.calls[0][1].employmentIds).not.toContain(id(999));
});
it.each([[],undefined,[id(1),id(1)],['malformed'],[id(1),id(999)]])('refuses empty, missing, duplicate, forged or foreign prepared Copy targets',async ids=>{
 await expect(copyRosterAction(form(ids))).rejects.toThrow('error=');expect(state.copy).not.toHaveBeenCalled();
});
it('generates only the complete explicit reviewed set',async()=>{
 const selected=Array.from({length:201},(_,i)=>id(i));state.ids=[...selected,id(999)];
 await expect(generateRosterAction(form(selected))).rejects.toThrow('generated=');
 expect(state.generate.mock.calls[0][1].employmentIds).toEqual(selected);
});
it('keeps department intent as an exact authorized subset of the canonical department population',async()=>{
 const data=form([id(1),id(2)]);data.set('departmentId',id(700));
 await expect(generateRosterAction(data)).rejects.toThrow('generated=');
 expect(state.department).toHaveBeenCalledWith(expect.anything(),{departmentId:id(700),shiftId:id(800)});
 expect(state.generate.mock.calls[0][1].employmentIds).toEqual([id(1),id(2)]);expect(state.generate.mock.calls[0][1]).not.toHaveProperty('departmentId');
});
it('intersects posted IDs with freshly resolved team membership instead of replacing that scope',async()=>{
 state.scope.mockResolvedValue({companyIds:[id(900)],employmentIds:[id(1)]});
 await expect(copyRosterAction(form([id(1),id(2)]))).rejects.toThrow('error=');
 expect(state.targets.mock.calls[0][1].employmentIds).toEqual([id(1)]);expect(state.copy).not.toHaveBeenCalled();
});

it.each([copyRosterAction,generateRosterAction])('rejects omitted and raw legacy target bypasses without an opt-in flag',async action=>{
 for(const raw of [[],[id(1)],[id(1),id(1)],[id(999)]]){
  const data=form(undefined);data.delete('selectionRequired');for(const value of raw)data.append('employmentIds',value);
  await expect(action(data)).rejects.toThrow('error=');
 }
 expect(state.copy).not.toHaveBeenCalled();expect(state.generate).not.toHaveBeenCalled();
});
it('refuses a department action with no exact prepared IDs',async()=>{
 const data=form(undefined);data.set('departmentId',id(700));
 await expect(generateRosterAction(data)).rejects.toThrow('error=');expect(state.department).not.toHaveBeenCalled();expect(state.generate).not.toHaveBeenCalled();
});
