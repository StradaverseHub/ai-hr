import {beforeEach,expect,it,vi} from 'vitest';
import {AuthRequiredError} from '../lib/auth-errors';

const state=vi.hoisted(()=>({session:vi.fn(),team:vi.fn(),celebrations:vi.fn()}));
vi.mock('@/lib/session',()=>({getSession:state.session}));
vi.mock('@/core/employee-home-sharing',()=>({readHomeTeamPage:state.team,readHomeCelebrationPage:state.celebrations}));
vi.mock('@/core/employee-home',()=>({HomeAccessError:class extends Error{constructor(readonly code:string){super('Private error');}}}));
import {HomeAccessError} from '@/core/employee-home';
import {GET} from '../app/api/home/sharing-initial/route';
import {todayInKualaLumpur} from '../lib/hr-date';
import {addDaysIso} from '../lib/roster-month';

const ctx={userId:'login',personId:'person'};
const date=todayInKualaLumpur();
const team={scope:'off',date,totalPeople:0,items:[],nextCursor:null};
const celebrations={scope:'off',from:date,to:addDaysIso(date,7),total:0,items:[],nextCursor:null};
const request=(query='employmentId=own',signal?:AbortSignal)=>new Request('http://local/api/home/sharing-initial?'+query,{signal});
const decode=(value:Uint8Array|undefined)=>JSON.parse(new TextDecoder().decode(value));
beforeEach(()=>{
 vi.resetAllMocks();
 state.session.mockResolvedValue(ctx);
 state.team.mockResolvedValue(team);
 state.celebrations.mockResolvedValue(celebrations);
});

it('authenticates once and delivers a healthy card before the failed sibling settles',async()=>{
 let failTeam:(error:Error)=>void=()=>{};
 state.team.mockImplementation(()=>new Promise((_,reject)=>{failTeam=reject;}));
 const response=await GET(request());
 expect(response.status).toBe(200);
 expect(response.headers.get('cache-control')).toBe('private, no-store');
 expect(response.headers.get('content-type')).toBe('application/x-ndjson');
 const reader=response.body!.getReader();
 expect(decode((await reader.read()).value)).toMatchObject({version:1,card:'celebrations',status:200,value:{employmentId:'own'}});
 failTeam(new HomeAccessError('employmentUnavailable'));
 expect(decode((await reader.read()).value)).toEqual({version:1,card:'team',status:403});
 expect((await reader.read()).done).toBe(true);
 expect(state.session).toHaveBeenCalledOnce();
 expect(state.team).toHaveBeenCalledWith(ctx,'own',{});
 expect(state.celebrations).toHaveBeenCalledWith(ctx,'own',{});
});

it.each(['employmentId=own&employmentId=other','employmentId=own&after=anything','employmentId=own&card=team','employmentId='])(
 'refuses non-default or ambiguous input %s',async query=>{
  expect((await GET(request(query))).status).toBe(400);
  expect(state.team).not.toHaveBeenCalled();
  expect(state.celebrations).not.toHaveBeenCalled();
 });

it('preserves signed-out refusal and never calls the owners',async()=>{
 state.session.mockRejectedValue(new AuthRequiredError('secret'));
 const response=await GET(request());
 expect(response.status).toBe(401);
 expect(await response.json()).toEqual({error:'authentication'});
 expect(state.team).not.toHaveBeenCalled();
 expect(state.celebrations).not.toHaveBeenCalled();
});

it('drops unfinished output when the browser cancels the stream',async()=>{
 let finishTeam:(value:unknown)=>void=()=>{};
 state.team.mockImplementation(()=>new Promise(resolve=>{finishTeam=resolve;}));
 const response=await GET(request());
 const reader=response.body!.getReader();
 await reader.read();
 await expect(reader.cancel()).resolves.toBeUndefined();
 finishTeam(team);
 expect((await reader.read()).done).toBe(true);
});
