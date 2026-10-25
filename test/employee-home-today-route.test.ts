import {todayInKualaLumpur} from '../lib/hr-date';
import {beforeEach,describe,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({session:vi.fn(),read:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:state.session}));
vi.mock('../core/employee-home-today',()=>({readEmployeeHomeToday:state.read}));
vi.mock('../core/employee-home',()=>({HomeAccessError:class extends Error{constructor(public code:string){super(code);}}}));
vi.mock('../packs/attendance/service',()=>({OwnClockEmploymentUnavailableError:class extends Error{}}));
vi.mock('../packs/payroll/service',()=>({OwnPayrollSubjectUnavailableError:class extends Error{}}));
import {GET} from '../app/api/home/today/route';
import {HomeAccessError} from '../core/employee-home';
const request=(query='employmentId=own')=>GET(new Request('http://localhost/api/home/today?'+query));
beforeEach(()=>{vi.clearAllMocks();state.session.mockResolvedValue({personId:'own-person'});state.read.mockResolvedValue({version:1,employmentId:'own',serverNow:new Date().toISOString(),businessDate:todayInKualaLumpur(),attendanceEnabled:true,payrollEnabled:true,clock:{date:todayInKualaLumpur(),clockedIn:false,openSince:null,workedSeconds:0,crossesMidnight:false,shift:{code:null,start:null,end:null,private:'secret'},geofencingRequired:false,photoRequired:false,captures:[{lat:3,photo:'secret'}]},dayKind:'workday',leavePresence:null,workLocations:{total:1,names:['HQ'],latitude:'secret'},payday:{date:todayInKualaLumpur(),daysAway:0,net:'secret'},salary:'secret'});});
describe('Home Today private transport',()=>{
 it('whitelists nested metadata and prevents shared caching',async()=>{
  const response=await request();expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('private, no-store');expect(response.headers.get('vary')).toContain('Cookie');
  expect(JSON.stringify(await response.json())).not.toMatch(/secret|captures|latitude|salary|net/);expect(state.read).toHaveBeenCalledWith({personId:'own-person'},'own');
 });
 it.each(['','employmentId=','employmentId=own&employmentId=own','employmentId=own&role=admin','employmentId=own&lat=3'])('refuses selector/extra input %s',async query=>{expect((await request(query)).status).toBe(400);expect(state.read).not.toHaveBeenCalled();});
 it('returns an own-subject refusal without private error text',async()=>{state.read.mockRejectedValue(new HomeAccessError('employmentUnavailable'));const response=await request();expect(response.status).toBe(403);expect(await response.json()).toEqual({error:'employmentUnavailable'});});
 it('isolates a failed owner without inventing an empty successful day',async()=>{state.read.mockRejectedValue(Error('secret SQL details'));const response=await request();expect(response.status).toBe(503);expect(await response.json()).toEqual({error:'unavailable'});});
});
