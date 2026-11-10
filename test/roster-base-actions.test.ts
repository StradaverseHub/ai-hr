/** Generate and Copy are one-submit server actions with the base form fields (repeated `employmentIds`,
 * optional `departmentId`). Before anything is queued the posted targets are admitted server-side against the
 * caller's company write scope, the freshly resolved team scope and the permitted population; the click then
 * enqueues the background roster job (core/roster-bulk-job.ts), whose worker applies the canonical writers'
 * own checks (test/roster-bulk-job.test.ts). Ported from the prepared-action admission cases. */
import {beforeEach,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({admin:true,ids:[] as string[],copy:vi.fn(),generate:vi.fn(),targets:vi.fn(),scope:vi.fn(),department:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:async()=>({tenantId:'tenant',userId:'user',roles:state.admin?['hr_admin']:['manager']})}));
vi.mock('../lib/authz',()=>({isAdmin:()=>state.admin}));
vi.mock('next/cache',()=>({revalidatePath:vi.fn()}));
vi.mock('next/navigation',()=>({redirect:(href:string)=>{throw new Error('REDIRECT '+href);}}));
vi.mock('next-intl/server',()=>({getTranslations:async()=>(key:string)=>key}));
vi.mock('../core/roster-bulk-job',()=>({enqueueRosterCopyJob:state.copy,enqueueRosterGenerateJob:state.generate,enqueueRosterAssignJob:vi.fn(),RosterBulkJobError:class extends Error{}}));
vi.mock('../core/roster',()=>({assertRosterAdmin:vi.fn(),assertRosterDatesWritable:vi.fn(),assignRosterRow:vi.fn(),assignShift:vi.fn(),assignShiftBulk:vi.fn(),clearRoster:vi.fn(),setRestDay:vi.fn(),RosterAdminRequiredError:class extends Error{constructor(){super('Administrators only');}}}));
vi.mock('../core/toil',()=>({accrueToil:vi.fn(),ToilFirstScheduleConsentRequiredError:Error}));
vi.mock('../core/roster-presentation',()=>({rosterPopulationIds:state.targets,rosterPopulationReview:state.department}));
vi.mock('../app/roster/population-scope',()=>({rosterPopulationScope:state.scope}));
import {copyRosterAction,generateRosterAction} from '../app/roster/actions';
const id=(n:number)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
beforeEach(()=>{
 vi.clearAllMocks();state.admin=true;state.ids=[id(1),id(2)];
 state.scope.mockResolvedValue({companyIds:[id(900)]});
 // The permitted population: the requested IDs that are currently in scope (or all of it when none are named).
 state.targets.mockImplementation(async(_s,p)=>p.employmentIds?p.employmentIds.filter((x:string)=>state.ids.includes(x)):state.ids.slice());
 state.department.mockImplementation(async()=>({ids:state.ids,page:{rows:[],total:state.ids.length}}));
 state.copy.mockResolvedValue({id:'copy-job'});state.generate.mockResolvedValue({id:'generate-job'});
});
function form(ids:string[]){const data=new FormData();data.set('companyId',id(900));data.set('populationQuery','view=month&month=2027-02');for(const value of ids)data.append('employmentIds',value);
 data.set('sourceFrom','2027-01-04');data.set('sourceTo','2027-01-05');data.set('targetFrom','2027-02-01');data.set('from','2027-02-01');data.set('to','2027-02-02');data.set('shiftId',id(800));return data;}

it('generates for the complete posted selection beyond a page in one submit',async()=>{
 const selected=Array.from({length:201},(_,i)=>id(i));state.ids=[...selected,id(999)];
 await expect(generateRosterAction(form(selected))).rejects.toThrow('rosterJob=generate-job');
 expect(state.generate).toHaveBeenCalledTimes(1);
 expect(state.generate.mock.calls[0][1]).toEqual({companyId:id(900),input:{shiftId:id(800),employmentIds:selected,from:'2027-02-01',to:'2027-02-02'}});
 expect(state.targets.mock.calls[0][1].employmentIds).toEqual(selected);
 // Company write scope comes from the session-resolved population scope, never the posted filters.
 expect(state.scope).toHaveBeenCalledWith(expect.anything(),expect.any(URLSearchParams),id(900),{requireWrite:true});
});
it('copies the complete posted workforce, with no later arrivals added',async()=>{
 const selected=Array.from({length:201},(_,i)=>id(i));state.ids=[...selected,id(999)];
 await expect(copyRosterAction(form(selected))).rejects.toThrow('rosterJob=copy-job');
 expect(state.copy.mock.calls[0][1]).toEqual({companyId:id(900),sourceFrom:'2027-01-04',sourceTo:'2027-01-05',targetFrom:'2027-02-01',employmentIds:selected});
 expect(state.copy.mock.calls[0][1].employmentIds).not.toContain(id(999));
});
it.each([
 ['forged',['malformed']],
 ['outside the permitted population',[id(1),id(999)]],
] as const)('refuses %s posted targets before any write',async(_case,ids)=>{
 await expect(generateRosterAction(form([...ids]))).rejects.toThrow('error=');
 await expect(copyRosterAction(form([...ids]))).rejects.toThrow('error=');
 expect(state.generate).not.toHaveBeenCalled();expect(state.copy).not.toHaveBeenCalled();
});
it('intersects posted IDs with freshly resolved team membership instead of replacing that scope',async()=>{
 state.scope.mockResolvedValue({companyIds:[id(900)],employmentIds:[id(1)],teamQuery:'view=month'});
 await expect(copyRosterAction(form([id(1),id(2)]))).rejects.toThrow('error=');
 expect(state.targets.mock.calls[0][1].employmentIds).toEqual([id(1)]);expect(state.copy).not.toHaveBeenCalled();
 await expect(generateRosterAction(form([id(1),id(2)]))).rejects.toThrow('error=');expect(state.generate).not.toHaveBeenCalled();
 await expect(generateRosterAction(form([id(1)]))).rejects.toThrow('rosterJob=generate-job');
 expect(state.generate.mock.calls[0][1].input.employmentIds).toEqual([id(1)]);
});
it('keeps department intent (it still wins) as the exact authorized subset of the canonical department population',async()=>{
 const data=form([id(5)]);data.set('departmentId',id(700));
 await expect(generateRosterAction(data)).rejects.toThrow('rosterJob=generate-job');
 expect(state.department).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({companyIds:[id(900)],department:{departmentId:id(700),shiftId:id(800)}}));
 expect(state.department.mock.calls[0][1]).not.toHaveProperty('selectedIds');
 expect(state.generate.mock.calls[0][1].input.reviewedDepartment).toEqual({departmentId:id(700),employmentIds:[id(1),id(2)],companyIds:[id(900)]});
 expect(state.generate.mock.calls[0][1].input).not.toHaveProperty('departmentId');expect(state.generate.mock.calls[0][1].input).not.toHaveProperty('employmentIds');
});
it('carries the fresh team query into the reviewed department so the writer rechecks team membership',async()=>{
 state.scope.mockResolvedValue({companyIds:[id(900)],employmentIds:[id(1)],teamQuery:'view=month'});
 const data=form([]);data.set('departmentId',id(700));
 await expect(generateRosterAction(data)).rejects.toThrow('rosterJob=generate-job');
 expect(state.department.mock.calls[0][1]).toMatchObject({employmentIds:[id(1)]});
 expect(state.generate.mock.calls[0][1].input.reviewedDepartment).toMatchObject({teamQuery:'view=month'});
});
it('bounds an empty Copy post to the current permitted population instead of the whole source window',async()=>{
 await expect(copyRosterAction(form([]))).rejects.toThrow('rosterJob=copy-job');
 expect(state.targets.mock.calls[0][1]).not.toHaveProperty('employmentIds');
 expect(state.copy.mock.calls[0][1].employmentIds).toEqual([id(1),id(2)]);
 state.ids=[];
 await expect(copyRosterAction(form([]))).rejects.toThrow('error=');expect(state.copy).toHaveBeenCalledTimes(1);
});
it('lets an empty Generate selection reach the writer, which refuses it with its own message',async()=>{
 // Queued unchanged; the worker's generator refuses it (test/roster-bulk-job.test.ts), and the panel then opens
 // the same ?error= this action redirected to.
 await expect(generateRosterAction(form([]))).rejects.toThrow('rosterJob=generate-job');
 expect(state.generate.mock.calls[0][1].input.employmentIds).toEqual([]);
 expect(state.targets).not.toHaveBeenCalled();
 // An admission refusal (here the writer's own input capture) still lands on ?error= with its sentence.
 state.generate.mockRejectedValueOnce(new Error('Dates must be YYYY-MM-DD'));
 await expect(generateRosterAction(form([]))).rejects.toThrow('error='+encodeURIComponent('Dates must be YYYY-MM-DD'));
});
it.each([['generate',generateRosterAction],['copy',copyRosterAction]] as const)('refuses %s for a team scope without roster write authority, a missing company, or a non-administrator',async(_name,action)=>{
 state.scope.mockRejectedValueOnce(new Error('Forbidden'));
 await expect(action(form([id(1)]))).rejects.toThrow('error=Forbidden');
 const missing=form([id(1)]);missing.set('companyId','');
 await expect(action(missing)).rejects.toThrow('error=');
 state.admin=false;
 await expect(action(form([id(1)]))).rejects.toThrow('error=');
 expect(state.generate).not.toHaveBeenCalled();expect(state.copy).not.toHaveBeenCalled();
});
