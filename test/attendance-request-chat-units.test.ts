/** AI v2 W2 — the parts of an attendance correction or overtime card prepared in chat that need no database: the card's
 * specific title in all six locales, the one question for missing details, the Kuala Lumpur midnight boundary of the
 * correction date, Confirm's refusals before any read and Edit's prefilled links. The owner reads and the review stores
 * are seams here (their real behaviour is test/proposal-attendance-request-chat.test.ts). Fictional values only. */
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createTranslator,type AbstractIntlMessages} from 'next-intl';
const state=vi.hoisted(()=>({own:vi.fn(),rows:vi.fn(),prepareCorrection:vi.fn(),confirmCorrection:vi.fn(),prepareOt:vi.fn(),confirmOt:vi.fn()}));
vi.mock('../core/read',()=>({myEmployment:state.own}));
vi.mock('../packs/attendance/service',async()=>({...(await import('../packs/attendance/exceptions')),attendanceForEmploymentRange:state.rows}));
vi.mock('../core/assistant-actions/attendance-correction-review-store',()=>({prepareAttendanceCorrectionReview:state.prepareCorrection,confirmAttendanceCorrectionReview:state.confirmCorrection}));
vi.mock('../core/assistant-actions/overtime-request-review-store',()=>({overtimeRequestReviews:{prepare:state.prepareOt,confirm:state.confirmOt}}));
import type {SessionContext} from '../db/client';
import en from '../messages/ai-centre/en.json';
import ms from '../messages/ai-centre/ms.json';
import zh from '../messages/ai-centre/zh.json';
import vi_ from '../messages/ai-centre/vi.json';
import ta from '../messages/ai-centre/ta.json';
import th from '../messages/ai-centre/th.json';
import {todayInKualaLumpur} from '../lib/hr-date';
import {attendanceRequestCardTitle,ATTENDANCE_TITLE_DATE,ATTENDANCE_TITLE_TIME} from '../lib/ai-centre/attendance-request-title';
import {issueProposal,type Proposal} from '../core/proposals/proposal';
import {attendanceEditHref,prepareChatAttendanceCorrectionProposal,prepareChatOvertimeRequestProposal} from '../core/proposals/attendance-request';
import {confirmAttendanceRequestProposal} from '../core/assistant-actions/attendance-request-proposal-confirm';

const CATALOGUES:Record<string,AbstractIntlMessages>={en,ms,zh,vi:vi_,ta,th} as unknown as Record<string,AbstractIntlMessages>;
const SECRET='fictional-proposal-signing-secret-0123456789abcdef';
const tenantId=randomUUID(),userId=randomUUID(),personId=randomUUID(),employmentId=randomUUID();
const caller={tenantId,userId,personId,roles:['employee']} as unknown as SessionContext;
const clone=<T>(value:T):T=>JSON.parse(JSON.stringify(value));
const day=(locale:string,iso:string)=>new Intl.DateTimeFormat(locale,ATTENDANCE_TITLE_DATE).format(new Date(iso+'T00:00:00.000Z'));
const clock=(locale:string,hhmm:string)=>new Intl.DateTimeFormat(locale,ATTENDANCE_TITLE_TIME).format(new Date('1970-01-01T'+hhmm+':00.000Z'));
function title(locale:string,action:string,selectors:Record<string,string>,facts:Record<string,string>){
 const t=createTranslator({locale,messages:CATALOGUES[locale],namespace:'aiCentre.conversation',onError:error=>{throw error;}});
 return attendanceRequestCardTitle({what:{action,selectors},facts},(key,values)=>t(key as never,values as never),
  date=>new Intl.DateTimeFormat(locale,ATTENDANCE_TITLE_DATE).format(date),time=>new Intl.DateTimeFormat(locale,ATTENDANCE_TITLE_TIME).format(time));
}
const CORRECTION={startDate:'2026-11-03',checkIn:'08:00',checkOut:'18:10'};
const OVERTIME={startDate:'2026-11-07',plannedStart:'09:00',plannedEnd:'13:00'};

describe('the card title names the day and the times in every locale',()=>{
 it('reads "Clock-out correction, Tue, Nov 3, 6:10 PM" in English, and names the other three kinds',()=>{
  expect(day('en','2026-11-03')).toBe('Tue, Nov 3');expect(clock('en','18:10')).toMatch(/^6:10\sPM$/u);
  expect(title('en','attendance.correction.request',{corrects:'check_out'},CORRECTION)).toBe(`Clock-out correction, Tue, Nov 3, ${clock('en','18:10')}`);
  expect(title('en','attendance.correction.request',{corrects:'check_in'},CORRECTION)).toBe(`Clock-in correction, Tue, Nov 3, ${clock('en','08:00')}`);
  expect(title('en','attendance.correction.request',{corrects:'both'},CORRECTION)).toBe(`Clock correction, Tue, Nov 3, ${clock('en','08:00')} – ${clock('en','18:10')}`);
  expect(title('en','attendance.overtime.request',{},OVERTIME)).toBe(`Overtime request, Sat, Nov 7, ${clock('en','09:00')} – ${clock('en','13:00')}`);
 });
 it.each([
  ['ms','Pembetulan waktu keluar','Pembetulan waktu masuk','Pembetulan waktu kehadiran','Permohonan kerja lebih masa',', '],
  ['zh','下班打卡更正','上班打卡更正','打卡更正','加班申请','，'],
  ['vi','Điều chỉnh giờ ra','Điều chỉnh giờ vào','Điều chỉnh chấm công','Yêu cầu làm thêm giờ',', '],
  ['ta','வெளியேறும் நேரத் திருத்தம்','வருகை நேரத் திருத்தம்','வருகைப் பதிவுத் திருத்தம்','கூடுதல் நேரக் கோரிக்கை',', '],
  ['th','แก้ไขเวลาออกงาน','แก้ไขเวลาเข้างาน','แก้ไขเวลาลงเวลา','คำขอทำงานล่วงเวลา',', '],
 ])('%s',(locale,out,into,both,overtime,comma)=>{
  const date=day(locale,'2026-11-03');
  expect(title(locale,'attendance.correction.request',{corrects:'check_out'},CORRECTION)).toBe(`${out}${comma}${date}${comma}${clock(locale,'18:10')}`);
  expect(title(locale,'attendance.correction.request',{corrects:'check_in'},CORRECTION)).toBe(`${into}${comma}${date}${comma}${clock(locale,'08:00')}`);
  expect(title(locale,'attendance.correction.request',{corrects:'both'},CORRECTION)).toBe(`${both}${comma}${date}${comma}${clock(locale,'08:00')} – ${clock(locale,'18:10')}`);
  expect(title(locale,'attendance.overtime.request',{},OVERTIME)).toBe(`${overtime}${comma}${day(locale,'2026-11-07')}${comma}${clock(locale,'09:00')} – ${clock(locale,'13:00')}`);
 });
 it('keeps the generic title for any other card, or one without its facts',()=>{
  const t=()=>{throw Error('not called');},format=()=>{throw Error('not called');};
  expect(attendanceRequestCardTitle({what:{action:'leave.apply',selectors:{corrects:'check_out'}},facts:CORRECTION},t,format,format)).toBeNull();
  expect(attendanceRequestCardTitle({what:{action:'attendance.correction.request',selectors:{}},facts:CORRECTION},()=>'x',()=>'d',()=>'t')).toBeNull();
  expect(attendanceRequestCardTitle({what:{action:'attendance.correction.request',selectors:{corrects:'check_out'}},facts:{startDate:'2026-11-03'}},()=>'x',()=>'d',()=>'t')).toBeNull();
  expect(attendanceRequestCardTitle({what:{action:'attendance.overtime.request',selectors:{}}},t,format,format)).toBeNull();
 });
 it('defines all four titles, both card names and the three new check labels in all six AI Centre catalogues',()=>{
  type Conversation={[key:string]:unknown;actions:Record<string,unknown>;checks:Record<string,unknown>};
  const english=(en as unknown as {aiCentre:{conversation:Conversation}}).aiCentre.conversation;
  for(const [locale,messages] of Object.entries(CATALOGUES)){
   const conversation=(messages as unknown as {aiCentre:{conversation:Conversation}}).aiCentre.conversation;
   for(const key of ['attendanceClockOutTitle','attendanceClockInTitle','attendanceClockBothTitle','overtimeRequestTitle']){
    expect(typeof conversation[key],locale+' '+key).toBe('string');if(locale!=='en')expect(conversation[key],locale+' '+key).not.toBe(english[key]);}
   for(const key of ['attendance_correction_request','attendance_overtime_request'])expect(typeof conversation.actions[key],locale+' '+key).toBe('string');
   for(const key of ['attendance_day_read','attendance_request_rules','approval_route'])expect(typeof conversation.checks[key],locale+' '+key).toBe('string');
  }
 });
});

const created=new Date('2026-11-03T01:00:00.000Z'),during=new Date(created.getTime()+60_000);
function preparedCorrection(intent:Record<string,unknown>){
 return{kind:'prepared',review:{action:'attendance.correction.request',contractVersion:1,actionId:randomUUID(),reviewedDigest:'b'.repeat(64),createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+600_000).toISOString(),
  review:{version:1,action:'attendance.correction.request',request:{...intent},before:{checkIn:'08:00:00',checkOut:null},meaning:'submit_for_existing_approval_not_clock_or_overtime_approval'}}};
}
const recordedDay=(date:string,checkInAt:string|null,checkOutAt:string|null)=>[{date,attendanceId:checkInAt?randomUUID():null,status:checkInAt?'present':null,context:null,checkInAt,checkOutAt,
 dayType:'workday',workedMinutes:null,scheduledMinutes:480,lateMinutes:0,earlyOutMinutes:0,shiftStart:'08:00:00',shiftEnd:'17:00:00',isRosterRest:false}];
beforeEach(()=>{
 vi.stubEnv('TERAS_PROPOSAL_SECRET',SECRET);vi.clearAllMocks();
 state.own.mockResolvedValue({employmentId,companyId:randomUUID()});
 state.prepareCorrection.mockImplementation(async(_ctx:unknown,input:{intent:Record<string,unknown>})=>preparedCorrection(input.intent));
 state.prepareOt.mockImplementation(async(_ctx:unknown,human:Record<string,string>)=>({kind:'prepared',review:{action:'attendance.overtime.request',contractVersion:1,actionId:randomUUID(),reviewedDigest:'c'.repeat(64),
  createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+600_000).toISOString(),content:human,
  review:{employmentId:human.employmentId,date:human.date,plannedStartTime:human.plannedStartTime,plannedEndTime:human.plannedEndTime,requestedOtMinutes:240,reason:human.reason,remark:null},consequence:'overtime_requested_not_approved'}}));
});
afterEach(()=>vi.unstubAllEnvs());

describe('a correction from chat: one question when something is missing, the day on record otherwise',()=>{
 const yesterday=()=>{const value=new Date(todayInKualaLumpur()+'T00:00:00Z');value.setUTCDate(value.getUTCDate()-1);return value.toISOString().slice(0,10);};
 it('asks for the time, the reason or a real date, and prepares nothing',async()=>{
  state.rows.mockResolvedValue(recordedDay(yesterday(),null,null));
  const words='I forgot to clock out yesterday at 6:10pm';
  // The person said "yesterday": the HR date owner's day goes back with the question, whatever date the model passed.
  const said={startDate:yesterday(),endDate:yesterday(),others:[],phrase:'yesterday'};
  // Nothing on record that day: the person says which time.
  expect(await prepareChatAttendanceCorrectionProposal(caller,{date:yesterday(),reason:'forgot to clock out'},words)).toEqual({kind:'ask',missing:['time'],options:[],dates:said});
  state.rows.mockResolvedValue(recordedDay(yesterday(),'08:00:00',null));
  expect(await prepareChatAttendanceCorrectionProposal(caller,{date:yesterday(),checkOut:'18:10'},words)).toEqual({kind:'ask',missing:['reason'],options:[],dates:said,recorded:{checkIn:'08:00'}});
  // A reason the person did not say is not theirs.
  expect(await prepareChatAttendanceCorrectionProposal(caller,{date:yesterday(),checkOut:'18:10',reason:'stuck in a client meeting'},words)).toEqual({kind:'ask',missing:['reason'],options:[],dates:said,recorded:{checkIn:'08:00'}});
  expect(await prepareChatAttendanceCorrectionProposal(caller,{date:'2026-02-30',checkOut:'18:10',reason:'forgot to clock out'},words)).toEqual({kind:'ask',missing:['date'],options:[]});
  expect(await prepareChatAttendanceCorrectionProposal(caller,{checkOut:'6:10pm',reason:'forgot to clock out'},words)).toEqual({kind:'ask',missing:['date','time'],options:[]});
  expect(state.prepareCorrection).not.toHaveBeenCalled();
 });
 it('asks only for the clock-out when the clock-in is on record, and gives the model the clock-in as a fact (eval 41843568709, emp-clockout-1)',async()=>{
  state.rows.mockResolvedValue(recordedDay(yesterday(),'08:00:00',null));
  // "I forgot to clock out yesterday": the model passes the person's words for the day; the HR date owner works it out.
  expect(await prepareChatAttendanceCorrectionProposal(caller,{date:'yesterday',reason:'forgot to clock out'},'I forgot to clock out yesterday'))
   .toEqual({kind:'ask',missing:['checkOut'],options:[],dates:{startDate:yesterday(),endDate:yesterday(),others:[],phrase:'yesterday'},recorded:{checkIn:'08:00'}});
  // Without the person's reason the service needs one (ADR-0069), so that is the one other thing asked for.
  expect(await prepareChatAttendanceCorrectionProposal(caller,{date:'yesterday'},'Please fix yesterday'))
   .toEqual({kind:'ask',missing:['checkOut','reason'],options:[],dates:{startDate:yesterday(),endDate:yesterday(),others:[],phrase:'yesterday'},recorded:{checkIn:'08:00'}});
  expect(state.rows).toHaveBeenCalledWith(expect.objectContaining({userId,personId}),employmentId,yesterday(),yesterday());
  // A clock-out on record and no clock-in: only the clock-in is asked for.
  state.rows.mockResolvedValue(recordedDay(yesterday(),null,'17:30:00'));
  expect(await prepareChatAttendanceCorrectionProposal(caller,{date:yesterday(),reason:'forgot to clock in'},'I forgot to clock in that day'))
   .toEqual({kind:'ask',missing:['checkIn'],options:[],recorded:{checkOut:'17:30'}});
  expect(state.prepareCorrection).not.toHaveBeenCalled();
 });
 it('works the day out from the person\'s words, never the model\'s own date, and refuses a day still to come',async()=>{
  // Wednesday 4 November 2026, noon in Kuala Lumpur.
  const now=new Date('2026-11-04T04:00:00.000Z');
  state.rows.mockResolvedValue(recordedDay('2026-11-03','08:00:00',null));
  // The model worked out the wrong day; the person said "yesterday", which is Tuesday 3 November.
  const outcome=await prepareChatAttendanceCorrectionProposal(caller,{date:'2026-11-02',checkOut:'18:10',reason:'forgot to clock out'},'I forgot to clock out yesterday at 6:10pm',now);
  if(outcome?.kind!=='proposal')throw Error('Fictional correction was not prepared: '+JSON.stringify(outcome));
  expect(state.rows).toHaveBeenLastCalledWith(expect.anything(),employmentId,'2026-11-03','2026-11-03');
  expect(outcome.proposal.body).toMatchObject({what:{selectors:{date:'2026-11-03',corrects:'check_out',checkOut:'18:10'}},facts:{startDate:'2026-11-03',checkIn:'08:00',checkOut:'18:10'}});
  expect(outcome.proposal.body.facts).not.toHaveProperty('otherDates');
  expect(outcome.dates).toEqual({startDate:'2026-11-03',endDate:'2026-11-03',others:[],phrase:'yesterday'});
  // "last Monday" on a Wednesday is 2 November, or 26 October: the card carries the other day; both are days worked.
  state.rows.mockResolvedValue(recordedDay('2026-11-02','08:00:00',null));
  const last=await prepareChatAttendanceCorrectionProposal(caller,{date:'last monday',checkOut:'18:10',reason:'forgot to clock out'},'I forgot to clock out last monday',now);
  if(last?.kind!=='proposal')throw Error('Fictional correction was not prepared: '+JSON.stringify(last));
  expect(last.proposal.body.facts).toMatchObject({startDate:'2026-11-02',otherDates:['2026-10-26']});
  // Tomorrow, or next Friday, is not a day worked yet: the person is asked for the date.
  for(const date of ['tomorrow','next friday'])
   expect(await prepareChatAttendanceCorrectionProposal(caller,{date,checkOut:'18:10',reason:'forgot to clock out'},'forgot to clock out',now)).toEqual({kind:'ask',missing:['date'],options:[]});
 });
 it('asks for the clock-in when the day has none on record, instead of taking one from the roster',async()=>{
  state.rows.mockResolvedValue(recordedDay(yesterday(),null,null));
  // The person said "yesterday", so the HR date owner's day goes back with the question.
  expect(await prepareChatAttendanceCorrectionProposal(caller,{date:yesterday(),checkOut:'18:10',reason:'forgot to clock out'},'I forgot to clock out yesterday at 6:10pm'))
   .toEqual({kind:'ask',missing:['checkIn'],options:[],dates:{startDate:yesterday(),endDate:yesterday(),others:[],phrase:'yesterday'}});
  expect(state.prepareCorrection).not.toHaveBeenCalled();
 });
 it('pairs the clock-out with the clock-in on record and files it as the screen does, with the reason only in the sealed review',async()=>{
  const date=yesterday();state.rows.mockResolvedValue(recordedDay(date,'08:00:00',null));
  const outcome=await prepareChatAttendanceCorrectionProposal(caller,{date,checkOut:'18:10',reason:'forgot to clock out',employmentId:randomUUID()},'I forgot to clock out yesterday at 6:10pm');
  if(outcome?.kind!=='proposal')throw Error('Fictional correction was not prepared: '+JSON.stringify(outcome));
  expect(state.rows).toHaveBeenCalledWith(expect.objectContaining({userId,personId}),employmentId,date,date);
  expect(state.prepareCorrection).toHaveBeenCalledWith(expect.objectContaining({userId,personId}),{action:'attendance.correction.request',contractVersion:1,
   intent:{version:1,employmentId,date,checkIn:'08:00',checkOut:'18:10',reason:'forgot to clock out',requestKind:'incomplete_entry'}});
  expect(outcome.proposal.body).toMatchObject({what:{action:'attendance.correction.request',entity:'attendance_request',effect:'create',selectors:{date,corrects:'check_out',checkOut:'18:10'},reviewedDigest:'b'.repeat(64)},
   forWhom:{subject:'own_employment',subjectId:employmentId},authority:{kind:'person',userId,personId},review:{route:'/assistant/attendance'},
   facts:{startDate:date,endDate:date,checkIn:'08:00',checkOut:'18:10',recordedCheckIn:'08:00',outcome:'submitted_not_approved'}});
  expect(outcome.proposal.body.review.href).toMatch(/^\/assistant\/attendance\?review=[0-9a-f-]{36}$/);
  expect(outcome.proposal.body.checks.map(check=>[check.check,check.result])).toEqual([['actor_current','pass'],['ai_controls_unpaused','pass'],['attendance_day_read','pass'],['attendance_request_rules','pass'],['approval_route','pass']]);
  expect(JSON.stringify(outcome.proposal)).not.toMatch(/forgot/);
 });
 it('takes "today" from the Kuala Lumpur HR date owner: a day is not in the future one minute after local midnight, while UTC still says it is',async()=>{
  // 00:01 in Kuala Lumpur, the day the person names; one minute before midnight it is still the day before.
  const after=new Date('2026-11-03T16:01:00.000Z'),before=new Date(after.getTime()-120_000);
  const named=todayInKualaLumpur(after);
  expect(todayInKualaLumpur(before)).not.toBe(named);expect(after.toISOString().slice(0,10)).not.toBe(named);
  state.rows.mockResolvedValue(recordedDay(named,null,null));
  const details={date:named,checkIn:'00:00',reason:'forgot to clock in'},words='I started my night shift at midnight and forgot to clock in';
  expect(await prepareChatAttendanceCorrectionProposal(caller,details,words,before)).toEqual({kind:'ask',missing:['date'],options:[]});
  expect(state.prepareCorrection).not.toHaveBeenCalled();
  // At 00:01 the same day is today: it goes to the attendance service, which decides the rest.
  await prepareChatAttendanceCorrectionProposal(caller,details,words,after);
  expect(state.prepareCorrection).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({intent:expect.objectContaining({date:named})}));
 });
 it('issues nothing when the service refuses or the caller has no own employment',async()=>{
  state.rows.mockResolvedValue(recordedDay(yesterday(),'08:00:00',null));state.prepareCorrection.mockRejectedValue(Error('refused'));
  expect(await prepareChatAttendanceCorrectionProposal(caller,{date:yesterday(),checkOut:'18:10',reason:'forgot'},'forgot')).toBeNull();
  state.own.mockResolvedValue(null);
  expect(await prepareChatAttendanceCorrectionProposal(caller,{date:yesterday(),checkOut:'18:10',reason:'forgot'},'forgot')).toBeNull();
 });
});

describe('an overtime request from chat',()=>{
 it('works out "this Saturday" from today in Kuala Lumpur, whatever date the model chose',async()=>{
  // Thursday 5 November 2026: this Saturday is 7 November.
  const now=new Date('2026-11-05T04:00:00.000Z'),words='plan overtime for me this Saturday from 9am to 1pm for the stock take';
  for(const date of ['this saturday','2026-11-14']){
   const outcome=await prepareChatOvertimeRequestProposal(caller,{date,plannedStartTime:'09:00',plannedEndTime:'13:00',reason:'stock take'},words,now);
   if(outcome?.kind!=='proposal')throw Error('Fictional overtime was not prepared: '+JSON.stringify(outcome));
   expect(state.prepareOt).toHaveBeenLastCalledWith(expect.anything(),expect.objectContaining({date:'2026-11-07'}));
   expect(outcome.proposal.body.facts).toMatchObject({startDate:'2026-11-07'});
  }
 });
 it('asks for what is missing, then shows the service\'s own minutes and nothing about pay',async()=>{
  const words='plan OT for me on 2026-11-07 from 9am to 1pm for the stock take';
  expect(await prepareChatOvertimeRequestProposal(caller,{date:'2026-11-07',plannedStartTime:'09:00',reason:'stock take'},words)).toEqual({kind:'ask',missing:['plannedEndTime'],options:[]});
  expect(await prepareChatOvertimeRequestProposal(caller,{date:'2026-11-07',plannedStartTime:'09:00',plannedEndTime:'09:00',reason:'stock take'},words)).toEqual({kind:'ask',missing:['plannedEndTime'],options:[]});
  expect(await prepareChatOvertimeRequestProposal(caller,{date:'2026-11-07',plannedStartTime:'09:00',plannedEndTime:'13:00'},words)).toEqual({kind:'ask',missing:['reason'],options:[]});
  expect(state.prepareOt).not.toHaveBeenCalled();
  const outcome=await prepareChatOvertimeRequestProposal(caller,{date:'2026-11-07',plannedStartTime:'09:00',plannedEndTime:'13:00',reason:'stock take'},words);
  if(outcome?.kind!=='proposal')throw Error('Fictional overtime was not prepared');
  expect(state.prepareOt).toHaveBeenCalledWith(expect.anything(),{action:'attendance.overtime.request',contractVersion:1,employmentId,date:'2026-11-07',plannedStartTime:'09:00',plannedEndTime:'13:00',reason:'stock take'});
  expect(outcome.proposal.body).toMatchObject({what:{action:'attendance.overtime.request',selectors:{date:'2026-11-07',plannedStartTime:'09:00',plannedEndTime:'13:00'}},
   facts:{startDate:'2026-11-07',plannedStart:'09:00',plannedEnd:'13:00',overtimeMinutes:240,outcome:'submitted_not_approved'}});
  expect(outcome.proposal.body.review.href).toMatch(/^\/assistant\/attendance\?flow=overtime&review=[0-9a-f-]{36}$/);
  expect(JSON.stringify(outcome.proposal)).not.toMatch(/stock|amount|rate|pay/i);
 });
});

function signed(action:'attendance.correction.request'|'attendance.overtime.request'|'leave.apply',extra:{subjectId?:string;selectors?:Record<string,string>}={}):Proposal{
 const correction=action==='attendance.correction.request';
 return issueProposal({what:{action,contractVersion:1,entity:action==='leave.apply'?'leave_request':'attendance_request',effect:'create',
   selectors:extra.selectors??(correction?{date:'2026-11-02',corrects:'check_out',checkOut:'18:10'}:{date:'2026-11-07',plannedStartTime:'09:00',plannedEndTime:'13:00'}),reviewedDigest:'a'.repeat(64)},
  forWhom:{tenantId,subject:'own_employment',subjectId:extra.subjectId??employmentId},authority:{kind:'person',tenantId,userId,personId},
  checks:[{check:'attendance_request_rules',owner:'packs/attendance/service.ts#prepareAttendanceCorrectionRequestTx',ruleVersion:null,result:'pass'}],
  review:action==='leave.apply'?{route:'/assistant/leave',href:'/assistant/leave?review='+employmentId,reference:employmentId}
   :{route:'/assistant/attendance',href:correction?'/assistant/attendance?review='+userId:'/assistant/attendance?flow=overtime&review='+userId,reference:userId},
  createdAt:created.toISOString(),expiresAt:new Date(created.getTime()+600_000).toISOString()});
}

describe('Confirm refuses before any read, and goes through the review store only on an explicit Confirm',()=>{
 it('needs an explicit Confirm, a signature that verifies, an unexpired card and the same person',async()=>{
  const proposal=signed('attendance.correction.request');
  for(const confirm of [undefined,null,false,'yes',1,{}])expect(await confirmAttendanceRequestProposal(caller,{proposal,confirm},during)).toEqual({kind:'refused',reason:'not_confirmed'});
  const forged=clone(proposal);forged.body.what.selectors.checkOut='23:59';
  expect(await confirmAttendanceRequestProposal(caller,{proposal:forged,confirm:true},during)).toEqual({kind:'refused',reason:'signature'});
  expect(await confirmAttendanceRequestProposal({...caller,personId:randomUUID()} as SessionContext,{proposal,confirm:true},during)).toEqual({kind:'refused',reason:'authority_mismatch'});
  expect(await confirmAttendanceRequestProposal({...caller,tenantId:randomUUID()} as SessionContext,{proposal,confirm:true},during)).toEqual({kind:'refused',reason:'authority_mismatch'});
  expect(await confirmAttendanceRequestProposal(caller,{proposal,confirm:true},new Date(Date.parse(proposal.body.expiresAt)))).toEqual({kind:'refused',reason:'expired'});
  expect(await confirmAttendanceRequestProposal(caller,{proposal:signed('leave.apply'),confirm:true},during)).toEqual({kind:'refused',reason:'wrong_action'});
  vi.stubEnv('TERAS_PROPOSAL_SECRET','');
  expect(await confirmAttendanceRequestProposal(caller,{proposal,confirm:true},during)).toEqual({kind:'refused',reason:'unavailable'});
  expect(state.confirmCorrection).not.toHaveBeenCalled();expect(state.confirmOt).not.toHaveBeenCalled();
 });
 it('hands the store its own confirmation and reports only what the store returns',async()=>{
  const correction=signed('attendance.correction.request'),overtime=signed('attendance.overtime.request'),requestId=randomUUID();
  state.confirmCorrection.mockResolvedValue({kind:'completed',receipt:{receipt:{correctionId:requestId}}});
  expect(await confirmAttendanceRequestProposal(caller,{proposal:correction,confirm:true},during)).toEqual({kind:'submitted',action:'attendance.correction.request',requestId});
  expect(state.confirmCorrection).toHaveBeenCalledWith(expect.objectContaining({userId,personId}),{action:'attendance.correction.request',contractVersion:1,actionId:userId,reviewedDigest:'a'.repeat(64)});
  state.confirmOt.mockResolvedValue({kind:'retired',receipt:{}});
  expect(await confirmAttendanceRequestProposal(caller,{proposal:overtime,confirm:true},during)).toEqual({kind:'refused',reason:'retired'});
  expect(state.confirmOt).toHaveBeenCalledWith(expect.anything(),{actionId:userId,reviewedDigest:'a'.repeat(64)});
  state.confirmOt.mockRejectedValue(Error('The attendance service refused it.'));
  expect(await confirmAttendanceRequestProposal(caller,{proposal:overtime,confirm:true},during)).toEqual({kind:'refused',reason:'unavailable'});
 });
});

describe('Edit opens the existing form on the card\'s own date and times, validated as the caller',()=>{
 it('opens the person\'s attendance day for a correction and Plan Overtime for an overtime request',async()=>{
  expect(await attendanceEditHref(caller,signed('attendance.correction.request'),during)).toEqual({ok:true,href:'/attendance/my-records/2026-11-02?checkOut=18%3A10'});
  expect(await attendanceEditHref(caller,signed('attendance.correction.request',{selectors:{date:'2026-11-02',corrects:'both',checkIn:'08:00',checkOut:'18:10'}}),during))
   .toEqual({ok:true,href:'/attendance/my-records/2026-11-02?checkIn=08%3A00&checkOut=18%3A10'});
  expect(await attendanceEditHref(caller,signed('attendance.overtime.request'),during)).toEqual({ok:true,href:'/attendance/plan-ot/apply?date=2026-11-07&start=09%3A00&end=13%3A00'});
 });
 it('refuses a tampered card, someone else\'s, another employment, a future correction day and a leave card',async()=>{
  const proposal=signed('attendance.correction.request'),forged=clone(proposal);forged.body.what.selectors.date='2026-11-01';
  expect(await attendanceEditHref(caller,forged,during)).toEqual({ok:false,reason:'signature'});
  expect(await attendanceEditHref({...caller,userId:randomUUID()} as SessionContext,proposal,during)).toEqual({ok:false,reason:'authority_mismatch'});
  expect(await attendanceEditHref(caller,signed('attendance.correction.request',{subjectId:randomUUID()}),during)).toEqual({ok:false,reason:'unavailable'});
  expect(await attendanceEditHref(caller,signed('attendance.correction.request',{selectors:{date:'2026-11-04',corrects:'check_out',checkOut:'18:10'}}),during)).toEqual({ok:false,reason:'unavailable'});
  expect(await attendanceEditHref(caller,signed('leave.apply',{selectors:{date:'2026-11-04'}}),during)).toEqual({ok:false,reason:'wrong_action'});
  state.own.mockResolvedValue(null);
  expect(await attendanceEditHref(caller,proposal,during)).toEqual({ok:false,reason:'unavailable'});
 });
});
