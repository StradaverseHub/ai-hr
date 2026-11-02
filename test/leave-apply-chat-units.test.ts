/** Issue 10 — the pure parts of a leave application prepared in chat: the card's specific title in all six locales,
 * the Request Leave form's prefill parse (server-side, seeds only), the card hint of a form card, and Confirm's refusals
 * that need no database (no explicit Confirm, a tampered or someone else's proposal). Fictional values only. */
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createTranslator,type AbstractIntlMessages} from 'next-intl';
import type {SessionContext} from '../db/client';
import en from '../messages/ai-centre/en.json';
import ms from '../messages/ai-centre/ms.json';
import zh from '../messages/ai-centre/zh.json';
import vi_ from '../messages/ai-centre/vi.json';
import ta from '../messages/ai-centre/ta.json';
import th from '../messages/ai-centre/th.json';
import {leaveApplyCardTitle,LEAVE_APPLY_TITLE_DATE} from '../lib/ai-centre/leave-apply-title';
import {leaveApplyPrefill} from '../lib/leave-apply-prefill';
import {issueProposal,type ProposalDraft} from '../core/proposals/proposal';
import {leaveApplyCardHint,leaveApplyReviewPackets} from '../core/proposals/leave-apply';
import {confirmLeaveApplyProposal} from '../core/assistant-actions/leave-apply-proposal-confirm';

const CATALOGUES:Record<string,AbstractIntlMessages>={en,ms,zh,vi:vi_,ta,th} as unknown as Record<string,AbstractIntlMessages>;
const day=(locale:string,iso:string)=>new Intl.DateTimeFormat(locale,LEAVE_APPLY_TITLE_DATE).format(new Date(iso+'T00:00:00.000Z'));
function title(locale:string,facts:Record<string,unknown>,durationType='full_day'){
 const t=createTranslator({locale,messages:CATALOGUES[locale],namespace:'aiCentre.conversation',onError:error=>{throw error;}});
 return leaveApplyCardTitle({what:{action:'leave.apply',selectors:{durationType}},facts:facts as never},(key,values)=>t(key,values),
  (date,options)=>new Intl.DateTimeFormat(locale,options).format(date));
}
const ONE={leaveType:'Annual Leave',startDate:'2026-11-05',endDate:'2026-11-05',days:1};
const RANGE={leaveType:'Annual Leave',startDate:'2026-11-09',endDate:'2026-11-11',days:3};
const HALF={leaveType:'Annual Leave',startDate:'2026-11-05',endDate:'2026-11-05',days:0.5};

describe('the card title names the leave type, dates and days in every locale',()=>{
 it('reads "Annual Leave, Thu, Nov 5 (1 day)" in English, with a range and a half day',()=>{
  expect(day('en','2026-11-05')).toBe('Thu, Nov 5');
  expect(title('en',ONE)).toBe('Annual Leave, Thu, Nov 5 (1 day)');
  expect(title('en',RANGE)).toBe('Annual Leave, Mon, Nov 9 – Wed, Nov 11 (3 days)');
  expect(title('en',HALF,'half_day_am')).toBe('Annual Leave, Thu, Nov 5 (half day, morning)');
  expect(title('en',HALF,'half_day_pm')).toBe('Annual Leave, Thu, Nov 5 (half day, afternoon)');
  expect(title('en',{...RANGE,days:1.5})).toBe('Annual Leave, Mon, Nov 9 – Wed, Nov 11 (1.5 days)');
 });
 it.each([
  ['ms','1 hari','3 hari','separuh hari, pagi',', ',' (',')'],
  ['zh','1 天','3 天','半天，上午','，','（','）'],
  ['vi','1 ngày','3 ngày','nửa ngày, buổi sáng',', ',' (',')'],
  ['ta','1 நாள்','3 நாட்கள்','அரை நாள், காலை',', ',' (',')'],
  ['th','1 วัน','3 วัน','ครึ่งวัน ช่วงเช้า',', ',' (',')'],
 ])('%s',(locale,one,three,half,comma,open,close)=>{
  expect(title(locale,ONE)).toBe(`Annual Leave${comma}${day(locale,'2026-11-05')}${open}${one}${close}`);
  expect(title(locale,RANGE)).toBe(`Annual Leave${comma}${day(locale,'2026-11-09')} – ${day(locale,'2026-11-11')}${open}${three}${close}`);
  expect(title(locale,HALF,'half_day_am')).toBe(`Annual Leave${comma}${day(locale,'2026-11-05')}${open}${half}${close}`);
 });
 it('keeps the generic title for any other card, or one without its facts',()=>{
  const t=()=>{throw Error('not called');},format=()=>{throw Error('not called');};
  expect(leaveApplyCardTitle({what:{action:'leave.cancel',selectors:{}},facts:ONE},t,format)).toBeNull();
  expect(leaveApplyCardTitle({what:{action:'leave.apply',selectors:{}},facts:{leaveType:'Annual Leave',startDate:'2026-11-05'}},t,format)).toBeNull();
  expect(leaveApplyCardTitle({what:{action:'leave.apply',selectors:{}}},t,format)).toBeNull();
 });
 it('defines both titles in all six AI Centre catalogues',()=>{
  for(const [locale,messages] of Object.entries(CATALOGUES)){
   const conversation=(messages as {aiCentre:{conversation:Record<string,unknown>}}).aiCentre.conversation;
   for(const key of ['leaveApplyTitle','leaveApplyRangeTitle'])expect(typeof conversation[key],locale+' '+key).toBe('string');
   if(locale!=='en')expect(conversation.leaveApplyTitle,locale).not.toBe((en as {aiCentre:{conversation:Record<string,unknown>}}).aiCentre.conversation.leaveApplyTitle);
  }
 });
});

describe('the Request Leave form prefill is parsed on the server and only seeds the form',()=>{
 it.each([
  [{applyEnd:'2026-11-11',applyDuration:'full_day'},{endDefault:'2026-11-11',durationDefault:'full_day'}],
  [{applyEnd:'2026-11-11'},{endDefault:'2026-11-11',durationDefault:'full_day'}],
  [{},{endDefault:'2026-11-09',durationDefault:'full_day'}],
  // An end before the start, or not a calendar date, is the start.
  [{applyEnd:'2026-11-01'},{endDefault:'2026-11-09',durationDefault:'full_day'}],
  [{applyEnd:'2026-02-30'},{endDefault:'2026-11-09',durationDefault:'full_day'}],
  [{applyEnd:['2026-11-11']},{endDefault:'2026-11-09',durationDefault:'full_day'}],
  // A half day is one date; hourly and anything unknown fall back to a full day.
  [{applyEnd:'2026-11-11',applyDuration:'half_day_pm'},{endDefault:'2026-11-09',durationDefault:'half_day_pm'}],
  [{applyDuration:'hourly'},{endDefault:'2026-11-09',durationDefault:'full_day'}],
  [{applyDuration:'<script>'},{endDefault:'2026-11-09',durationDefault:'full_day'}],
 ])('%j',(sp,expected)=>{expect(leaveApplyPrefill(sp,'2026-11-09')).toEqual(expected);});
});

describe('Confirm refuses before any read',()=>{
 const SECRET='fictional-proposal-signing-secret-0123456789abcdef';
 const tenantId=randomUUID(),userId=randomUUID(),personId=randomUUID(),employmentId=randomUUID(),leaveTypeId=randomUUID();
 const caller={tenantId,userId,personId,roles:['employee']} as unknown as SessionContext;
 const created=new Date('2026-11-03T01:00:00.000Z'),during=new Date(created.getTime()+60_000);
 const draft=(route:'/leave'|'/assistant/leave'):ProposalDraft=>({what:{action:'leave.apply',contractVersion:1,entity:'leave_request',effect:'create',
  selectors:route==='/leave'?{startDate:'2026-11-09',endDate:'2026-11-11',durationType:'full_day',leaveTypeId}:{date:'2026-11-09',durationType:'full_day',leaveTypeId},reviewedDigest:'a'.repeat(64)},
  forWhom:{tenantId,subject:'own_employment',subjectId:employmentId},authority:{kind:'person',tenantId,userId,personId},
  checks:[{check:'deduction_and_balance',owner:'packs/leave/service.ts#previewLeaveDeduction',ruleVersion:null,result:'pass'}],
  review:route==='/leave'?{route,href:route,reference:leaveTypeId}:{route,href:route+'?review='+employmentId,reference:employmentId},
  createdAt:created.toISOString(),expiresAt:new Date(created.getTime()+600_000).toISOString()});
 beforeEach(()=>vi.stubEnv('TERAS_PROPOSAL_SECRET',SECRET));
 afterEach(()=>vi.unstubAllEnvs());
 it('needs an explicit Confirm, a signature that verifies and the same person',async()=>{
  const proposal=issueProposal(draft('/assistant/leave'));
  for(const confirm of [undefined,null,false,'yes',1,{}])expect(await confirmLeaveApplyProposal(caller,{proposal,confirm},'en',during)).toEqual({kind:'refused',reason:'not_confirmed'});
  const forged=JSON.parse(JSON.stringify(proposal));forged.body.what.selectors.date='2026-11-10';
  expect(await confirmLeaveApplyProposal(caller,{proposal:forged,confirm:true},'en',during)).toEqual({kind:'refused',reason:'signature'});
  expect(await confirmLeaveApplyProposal({...caller,personId:randomUUID()} as SessionContext,{proposal,confirm:true},'en',during)).toEqual({kind:'refused',reason:'authority_mismatch'});
  expect(await confirmLeaveApplyProposal(caller,{proposal,confirm:true},'en',new Date(Date.parse(proposal.body.expiresAt)))).toEqual({kind:'refused',reason:'expired'});
  vi.stubEnv('TERAS_PROPOSAL_SECRET','');
  expect(await confirmLeaveApplyProposal(caller,{proposal,confirm:true},'en',during)).toEqual({kind:'refused',reason:'unavailable'});
 });
 it('never turns a form card into a review confirmation, and its card hint names its start date',()=>{
  const form=issueProposal(draft('/leave'));
  expect(leaveApplyReviewPackets(form,caller,during)).toEqual({ok:false,reason:'wrong_action'});
  expect(leaveApplyCardHint(form)).toMatchObject({action:'leave.apply',hints:{date:'2026-11-09'},reviewHref:'/leave'});
 });
});
