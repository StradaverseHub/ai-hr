import {beforeEach,expect,it,vi} from 'vitest';
import {AuthRequiredError} from '../lib/auth-errors';

const state=vi.hoisted(()=>({session:vi.fn(),team:vi.fn(),celebrations:vi.fn(),notices:vi.fn(),timeOff:vi.fn(),
 greeting:vi.fn(),summary:vi.fn(),tasks:vi.fn()}));
vi.mock('@/lib/session',()=>({getSession:state.session}));
vi.mock('@/core/employee-home-sharing',()=>({readHomeTeamPage:state.team,readHomeCelebrationPage:state.celebrations}));
vi.mock('@/core/employee-home-notices',()=>({readEmployeeHomeNotices:state.notices}));
vi.mock('@/core/employee-home-time-off',()=>({readEmployeeHomeTimeOff:state.timeOff}));
vi.mock('next-intl/server',()=>({getLocale:async()=>'en',getTranslations:async()=>()=> 'Replacement holiday'}));
vi.mock('@/core/employee-home-configuration',()=>({OwnHomeConfigurationRead:class{
 constructor(readonly session:unknown,readonly employmentId:string){}
}}));
vi.mock('@/core/employee-home-greeting',()=>({readEmployeeHomeGreeting:state.greeting}));
vi.mock('@/core/employee-home-summary',()=>({readEmployeeHomeSummary:state.summary}));
vi.mock('@/core/employee-home-tasks',()=>({readEmployeeHomeTasks:state.tasks,OwnHomeTaskSourceRead:class{
 constructor(readonly session:unknown,readonly employmentId:string){}
}}));
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

it.each(['employmentId=own&employmentId=other','employmentId=own&after=anything','employmentId=own&card=team','employmentId=own&card=team&card=team','employmentId=own&card=team&card=unknown','employmentId='])(
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
 expect(state.greeting).not.toHaveBeenCalled();
 expect(state.summary).not.toHaveBeenCalled();
 expect(state.tasks).not.toHaveBeenCalled();
});

it('reuses the exact request configuration carrier while independently projecting greeting, summary, and tasks',async()=>{
 const serverNow=new Date().toISOString();
 const greeting={version:1,employmentId:'own',serverNow,displayDate:date,timeZone:'Asia/Kuala_Lumpur',
  message:'Fictional greeting',templateKey:'greetingMorning',photoHref:null};
 const tasks={version:1,employmentId:'own',grain:'account',asOf:date,total:0,overdue:0,effortMinutes:0,
  unestimated:0,page:1,pages:1,pageSize:12,items:[]};
 state.greeting.mockResolvedValue({...greeting,privateDateOfBirth:date});
 state.tasks.mockResolvedValue({...tasks,privateReason:'not sent'});
 state.summary.mockRejectedValue(Error('Private summary failure'));
 const response=await GET(request('employmentId=own&card=greeting&card=summary&card=tasks'));
 const frames=(await response.text()).trim().split('\n').map(line=>JSON.parse(line)).sort((a,b)=>a.card.localeCompare(b.card));
 expect(frames).toEqual([
  {version:1,card:'greeting',status:200,value:greeting},
  {version:1,card:'summary',status:503},
  {version:1,card:'tasks',status:200,value:tasks},
 ]);
 expect(state.session).toHaveBeenCalledOnce();
 const carrier=state.greeting.mock.calls[0][4];
 const taskCarrier=state.summary.mock.calls[0][5];
 expect(carrier).toMatchObject({session:ctx,employmentId:'own'});
 expect(taskCarrier).toMatchObject({session:ctx,employmentId:'own'});
 expect(taskCarrier).not.toBe(carrier);
 expect(state.greeting).toHaveBeenCalledWith(ctx,'own','en',undefined,carrier);
 expect(state.summary).toHaveBeenCalledWith(ctx,'own','en','Replacement holiday',carrier,taskCarrier);
 expect(state.tasks).toHaveBeenCalledWith(ctx,'own',1,carrier,taskCarrier);
 expect(state.summary.mock.calls[0][4]).toBe(carrier);
 expect(state.tasks.mock.calls[0][3]).toBe(carrier);
 expect(state.tasks.mock.calls[0][4]).toBe(taskCarrier);
 expect(state.team).not.toHaveBeenCalled();
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


it('authenticates selected personal cards once without reading unrequested cards',async()=>{
 state.notices.mockResolvedValue({version:1,employmentId:'own',total:0,unread:0,acknowledgementRequired:0,items:[]});
 state.timeOff.mockResolvedValue({version:1,employmentId:'own',asOf:date,canApply:false,balances:[],nextApproved:null});
 const response=await GET(request('employmentId=own&card=notices&card=timeOff'));
 const frames=(await response.text()).trim().split('\n').map(line=>JSON.parse(line)).sort((a,b)=>a.card.localeCompare(b.card));
 expect(frames).toEqual([
  {version:1,card:'notices',status:200,value:{version:1,employmentId:'own',total:0,unread:0,acknowledgementRequired:0,items:[]}},
  {version:1,card:'timeOff',status:200,value:{version:1,employmentId:'own',asOf:date,canApply:false,balances:[],nextApproved:null}},
 ]);
 expect(state.session).toHaveBeenCalledOnce();
 expect(state.notices).toHaveBeenCalledWith(ctx,'own');
 expect(state.timeOff).toHaveBeenCalledWith(ctx,'own','en');
 expect(state.team).not.toHaveBeenCalled();
 expect(state.celebrations).not.toHaveBeenCalled();
});
