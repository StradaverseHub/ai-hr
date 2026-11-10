/** Generate and Copy are one-submit server actions with the base inputs: the posted employees (or a whole
 * department, which wins) go straight to the canonical writers, which own every authority check. */
import {beforeEach,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({admin:true,copy:vi.fn(),generate:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:async()=>({tenantId:'tenant',userId:'user',roles:state.admin?['hr_admin']:['manager']})}));
vi.mock('../lib/authz',()=>({isAdmin:()=>state.admin}));
vi.mock('next/cache',()=>({revalidatePath:vi.fn()}));
vi.mock('next/navigation',()=>({redirect:(href:string)=>{throw new Error('REDIRECT '+href);}}));
vi.mock('../core/roster',()=>({copyRoster:state.copy,generateRosterFromTemplate:state.generate,assertRosterAdmin:vi.fn(),assertRosterDatesWritable:vi.fn(),assignRosterRow:vi.fn(),assignShift:vi.fn(),assignShiftBulk:vi.fn(),clearRoster:vi.fn(),setRestDay:vi.fn(),RosterAdminRequiredError:class extends Error{constructor(){super('Administrators only');}}}));
vi.mock('../core/toil',()=>({accrueToil:vi.fn(),ToilFirstScheduleConsentRequiredError:Error}));
import {copyRosterAction,generateRosterAction} from '../app/roster/actions';
const id=(n:number)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
beforeEach(()=>{vi.clearAllMocks();state.admin=true;state.copy.mockResolvedValue({copied:2,sourceRows:2});state.generate.mockResolvedValue({employments:2,workingRows:2,restRows:0});});
function form(ids:string[]){const data=new FormData();data.set('companyId',id(900));for(const value of ids)data.append('employmentIds',value);
 data.set('sourceFrom','2027-01-04');data.set('sourceTo','2027-01-05');data.set('targetFrom','2027-02-01');data.set('from','2027-02-01');data.set('to','2027-02-02');data.set('shiftId',id(800));return data;}

it('generates for the posted employees in one submit',async()=>{
 const selected=Array.from({length:201},(_,i)=>id(i));
 await expect(generateRosterAction(form(selected))).rejects.toThrow('generated=2.2.0');
 expect(state.generate).toHaveBeenCalledTimes(1);
 expect(state.generate.mock.calls[0][1]).toEqual({shiftId:id(800),employmentIds:selected,from:'2027-02-01',to:'2027-02-02'});
});
it('lets a chosen department win over the employee selection, as before',async()=>{
 const data=form([id(1)]);data.set('departmentId',id(700));
 await expect(generateRosterAction(data)).rejects.toThrow('generated=');
 expect(state.generate.mock.calls[0][1]).toEqual({shiftId:id(800),departmentId:id(700),from:'2027-02-01',to:'2027-02-02'});
});
it('copies the posted workforce in one submit, and the whole source window when none is posted',async()=>{
 const workforce=Array.from({length:201},(_,i)=>id(i));
 await expect(copyRosterAction(form(workforce))).rejects.toThrow('copied=2');
 expect(state.copy.mock.calls[0][1]).toEqual({sourceFrom:'2027-01-04',sourceTo:'2027-01-05',targetFrom:'2027-02-01',employmentIds:workforce});
 await expect(copyRosterAction(form([]))).rejects.toThrow('copied=2');
 expect(state.copy.mock.calls[1][1]).not.toHaveProperty('employmentIds');
});
it.each([['generate',generateRosterAction],['copy',copyRosterAction]] as const)('refuses a non-administrator %s before any write',async(_name,action)=>{
 state.admin=false;
 await expect(action(form([id(1)]))).rejects.toThrow('error=');
 expect(state.generate).not.toHaveBeenCalled();expect(state.copy).not.toHaveBeenCalled();
});
it('returns a writer refusal to the roster as an error banner',async()=>{
 state.generate.mockRejectedValue(new Error('No employees in scope — pick employees or a department with members'));
 await expect(generateRosterAction(form([]))).rejects.toThrow('error=');
});
