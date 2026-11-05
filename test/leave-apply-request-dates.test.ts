/** Owner, 5 November 2026 ("Fix dates first"): a leave application from chat takes its dates from the HR date owner's rule
 * (lib/hr-date-phrase.ts through core/proposals/request-dates.ts), never from the model.
 *
 * Eval 41843568709 (emp-apply-2, "annual leave next friday" on Wednesday 4 November 2026) took 6 November on one pass and
 * 13 November on the other. By the owner's rule (5 November 2026, "Next week's Friday": next <weekday> is that weekday of
 * the following Monday-to-Sunday week) the same words give 13 November whichever date the model passed, the card carries 6
 * November (this week's Friday, still to come) as the other date the person may have meant, a week phrase becomes a Monday-to-Sunday range for the leave
 * service to count, and a date the person wrote out stays theirs. The leave owners (the apply menu, the review store, the
 * form preview) are seams whose real behaviour is test/proposal-leave-apply-chat.test.ts; the leave service's own date
 * checks are not touched. Every expected date is written out by hand. Fictional values only; no database. */
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({menu:vi.fn(),candidate:vi.fn(),review:vi.fn()}));
vi.mock('../core/assistant-actions/own-leave-apply-form',async importOriginal=>({...await importOriginal<typeof import('../core/assistant-actions/own-leave-apply-form')>(),
 readOwnLeaveApplyMenu:state.menu,readOwnLeaveApplyFormCandidate:state.candidate}));
vi.mock('../core/assistant-actions/own-leave-store',()=>({prepareOwnLeaveReviewTx:state.review}));
vi.mock('../db/client',async importOriginal=>({...await importOriginal<typeof import('../db/client')>(),withTenant:async(_ctx:unknown,work:(tx:unknown)=>unknown)=>work({})}));
import type {SessionContext} from '../db/client';
import {OWN_LEAVE_CONTRACT_VERSION} from '../lib/assistant-actions/own-leave-contract';
import {prepareChatLeaveApplyProposal} from '../core/proposals/suggested';

const tenantId=randomUUID(),userId=randomUUID(),personId=randomUUID(),employmentId=randomUUID(),annualId=randomUUID(),medicalId=randomUUID();
const caller={tenantId,userId,personId,roles:['employee']} as unknown as SessionContext;
/** Wednesday 4 November 2026, noon in Kuala Lumpur. */
const now=new Date('2026-11-04T04:00:00.000Z');
beforeEach(()=>{
 vi.stubEnv('TERAS_PROPOSAL_SECRET','fictional-proposal-signing-secret-0123456789abcdef');vi.clearAllMocks();
 state.menu.mockResolvedValue({kind:'menu',employmentId,types:[
  {id:annualId,name:'Annual Leave',code:'ANNUAL',durations:['full_day','half_day_am','half_day_pm'],role:'annual',names:['Annual Leave']},
  {id:medicalId,name:'Medical Leave',code:'MEDICAL',durations:['full_day'],role:'medical',names:['Medical Leave']}]});
 // The review store prepares the one day it was nominated, as the leave service would after its own checks.
 state.review.mockImplementation(async(_tx:unknown,_ctx:unknown,nomination:{date:string;durationType:string})=>({kind:'prepared',review:{
  actionId:randomUUID(),contractVersion:OWN_LEAVE_CONTRACT_VERSION,date:nomination.date,durationType:nomination.durationType,reviewedDigest:'d'.repeat(64),
  leaveTypeName:'Annual Leave',deductionDays:1,estimatedAvailableAfter:null,createdAt:now.toISOString(),expiresAt:new Date(now.getTime()+600_000).toISOString()}}));
 state.candidate.mockResolvedValue({kind:'candidate',employmentId,leaveTypeName:'Annual Leave',days:5,availableAfter:null,covered:true});
});
afterEach(()=>vi.unstubAllEnvs());
const nominated=()=>state.review.mock.calls.map(call=>(call[2] as {date:string}).date);

describe('"annual leave next friday" on Wednesday 4 November 2026',()=>{
 it('is Friday 13 November whether the model passed the words or either date it chose, with 6 November on the card',async()=>{
  for(const startDate of ['next friday','2026-11-06','2026-11-13']){
   const outcome=await prepareChatLeaveApplyProposal(caller,{leaveType:'annual',startDate},'annual leave next friday','en',now);
   if(outcome?.kind!=='proposal')throw Error('Fictional application was not prepared: '+JSON.stringify(outcome));
   expect(outcome.proposal.body.what.selectors).toMatchObject({date:'2026-11-13',durationType:'full_day',leaveTypeId:annualId});
   expect(outcome.proposal.body.facts).toMatchObject({leaveType:'Annual Leave',startDate:'2026-11-13',endDate:'2026-11-13',otherDates:['2026-11-06']});
   expect(outcome.dates).toEqual({startDate:'2026-11-13',endDate:'2026-11-13',others:['2026-11-06'],phrase:'next friday'});
  }
  // The leave service was asked about 13 November every time, never 6 November.
  expect(nominated()).toEqual(['2026-11-13','2026-11-13','2026-11-13']);
 });
 it('names the worked-out date in the one question when the leave type is still to choose',async()=>{
  expect(await prepareChatLeaveApplyProposal(caller,{startDate:'next friday'},'leave next friday','en',now)).toEqual({kind:'ask',missing:['leaveType'],
   options:[{option:1,leaveType:'Annual Leave'},{option:2,leaveType:'Medical Leave'}],dates:{startDate:'2026-11-13',endDate:'2026-11-13',others:['2026-11-06'],phrase:'next friday'}});
  expect(state.review).not.toHaveBeenCalled();
 });
});

describe('other phrases and dates',()=>{
 it('keeps a date the person wrote out, with no other date',async()=>{
  const outcome=await prepareChatLeaveApplyProposal(caller,{leaveType:'annual',startDate:'2026-11-13'},'annual leave on 13 November','en',now);
  if(outcome?.kind!=='proposal')throw Error('not prepared');
  expect(outcome.proposal.body.facts).toMatchObject({startDate:'2026-11-13',endDate:'2026-11-13'});
  expect(outcome.proposal.body.facts).not.toHaveProperty('otherDates');
 });
 it('turns "next week" into Monday 9 to Sunday 15 November on the Request Leave form, for the leave service to count',async()=>{
  const outcome=await prepareChatLeaveApplyProposal(caller,{leaveType:'annual',startDate:'next week'},'I want annual leave next week','en',now);
  if(outcome?.kind!=='proposal')throw Error('not prepared');
  expect(state.candidate).toHaveBeenCalledWith(expect.anything(),{leaveTypeId:annualId,startDate:'2026-11-09',endDate:'2026-11-15',durationType:'full_day'},'en',now);
  expect(outcome.proposal.body.review.route).toBe('/leave');
  expect(outcome.proposal.body.facts).toMatchObject({startDate:'2026-11-09',endDate:'2026-11-15',days:5});
  expect(outcome.proposal.body.facts).not.toHaveProperty('otherDates');
 });
 it('reads Malay and Chinese days the same way',async()=>{
  for(const [startDate,words,expected] of [['明天','帮我请明天的病假','2026-11-05'],['esok','cuti sakit esok','2026-11-05'],['Jumaat depan','cuti Jumaat depan','2026-11-13'],['Jumaat ini','cuti Jumaat ini','2026-11-06'],['下周五','下周五请病假','2026-11-13']]){
   const outcome=await prepareChatLeaveApplyProposal(caller,{leaveType:'Medical Leave',startDate},words,'zh',now);
   if(outcome?.kind!=='proposal')throw Error('not prepared: '+startDate);
   expect(outcome.proposal.body.facts?.startDate,startDate).toBe(expected);
  }
 });
 it('asks for the date when the words name none, or the end when it is unclear',async()=>{
  expect(await prepareChatLeaveApplyProposal(caller,{leaveType:'annual',startDate:'sometime soon'},'annual leave sometime soon','en',now)).toEqual({kind:'ask',missing:['startDate'],options:[]});
  expect(await prepareChatLeaveApplyProposal(caller,{leaveType:'annual',startDate:'next friday',endDate:'later'},'annual leave next friday until later','en',now)).toEqual({kind:'ask',missing:['endDate'],options:[]});
  expect(state.review).not.toHaveBeenCalled();expect(state.candidate).not.toHaveBeenCalled();
 });
});
