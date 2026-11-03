/** AI v2 W2 — the pure parts of an own claim or profile change prepared in chat: what counts as the person's own
 * words (amounts, bank account and phone numbers read only from their message), the card titles in all six locales,
 * and Confirm and Edit refusing before any read (no explicit Confirm, a tampered, expired, someone else's or retargeted
 * proposal). Fictional values only; no database. */
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
import {OWN_CHANGE_TITLE_DATE,OWN_CHANGE_TITLE_KEYS,ownChangeCardTitle} from '../lib/ai-centre/own-change-title';
import {matchNamed,oneBankAccountIn,onePhoneIn,ownWords,parseStatedAmount,statedAmounts,wordsStateAmount} from '../core/proposals/own-words';
import {issueProposal,type ProposalDraft} from '../core/proposals/proposal';
import {OWN_CHANGE_ACTIONS} from '../core/semantic-model/entities-own-changes';
import {confirmOwnChangeProposal,editOwnChangeProposal} from '../core/assistant-actions/own-change-proposal-confirm';

const CATALOGUES:Record<string,AbstractIntlMessages>={en,ms,zh,vi:vi_,ta,th} as unknown as Record<string,AbstractIntlMessages>;
type Conversation={aiCentre:{conversation:Record<string,unknown>&{checks:Record<string,unknown>;outcomes:Record<string,unknown>;actions:Record<string,unknown>}}};
const day=(locale:string,iso:string)=>new Intl.DateTimeFormat(locale,OWN_CHANGE_TITLE_DATE).format(new Date(iso+'T00:00:00.000Z'));
function title(locale:string,action:string,facts:Record<string,unknown>){
 const t=createTranslator({locale,messages:CATALOGUES[locale],namespace:'aiCentre.conversation',onError:error=>{throw error;}});
 return ownChangeCardTitle({what:{action},facts:facts as never},(key,values)=>t(key as never,values as never),date=>new Intl.DateTimeFormat(locale,OWN_CHANGE_TITLE_DATE).format(date));
}
const CLAIM={claimType:'Travel',incurredOn:'2026-10-31',amount:'42.60'};

describe('the person\'s own words',()=>{
 it('reads an amount only as the person states it, to the cent',()=>{
  expect(statedAmounts('Taxi to the client, RM42.60 on 31 Oct')).toEqual(expect.arrayContaining([42.6,31]));
  expect(wordsStateAmount('Taxi to the client, RM42.60',42.6)).toBe(true);
  expect(wordsStateAmount('Taxi to the client, RM42.60',42.06)).toBe(false);
  expect(wordsStateAmount('Hotel RM 1,200.50 last night',1200.5)).toBe(true);
  expect(wordsStateAmount('Hotel RM 1,200.50 last night',1200)).toBe(false);
  expect(wordsStateAmount('Claim my taxi please',42.6)).toBe(false);
  expect(wordsStateAmount(undefined,42.6)).toBe(false);
  expect([parseStatedAmount('RM 42.6'),parseStatedAmount('1,200.50'),parseStatedAmount(42.6),parseStatedAmount('42.605'),parseStatedAmount('-5'),parseStatedAmount('0'),parseStatedAmount('ten')])
   .toEqual([42.6,1200.5,42.6,null,null,null,null]);
 });
 it('reads a bank account number from the person\'s words, never a phone number or an NRIC, and only when there is one',()=>{
  expect(oneBankAccountIn('Change my bank account to Maybank 514012345678 please')).toBe('514012345678');
  expect(oneBankAccountIn('My new CIMB account is 8001-2345-6789')).toBe('800123456789');
  expect(oneBankAccountIn('Call me on 012-345 6789 about my bank')).toBeNull();
  expect(oneBankAccountIn('My IC is 900101-14-5678, change my bank')).toBeNull();
  expect(oneBankAccountIn('Accounts 514012345678 and 514012345679')).toBeNull();
  expect(oneBankAccountIn('Change my bank to Maybank')).toBeNull();
  expect(onePhoneIn('Make my wife Aisha my emergency contact, 012-345 6789')).toBe('012-345 6789');
  expect(onePhoneIn('No number here')).toBeNull();
 });
 it('keeps a value only when the person said it, and names one of a closed list',()=>{
  expect(ownWords('12 Jalan Ampang','My new address is 12  JALAN ampang, 50450 KL',200)).toBe('12 Jalan Ampang');
  expect(ownWords('13 Jalan Ampang','My new address is 12 Jalan Ampang',200)).toBeNull();
  expect(ownWords('','anything',200)).toBeNull();
  const rows=[{name:'Travel',code:'TRV'},{name:'Meal allowance',code:'MEAL'},{name:'Medical',code:'MED'}];
  expect(matchNamed(rows,'travel')?.code).toBe('TRV');
  expect(matchNamed(rows,'MEAL')?.code).toBe('MEAL');
  expect(matchNamed(rows,'meal')?.code).toBe('MEAL');
  expect(matchNamed(rows,'Parking')).toBeNull();
  expect(matchNamed([...rows,{name:'Travel overseas',code:'TRVO'}],'trav')).toBeNull();
 });
});

describe('the card title names the claim or the change in every locale',()=>{
 it('reads "Travel claim, RM 42.60, Oct 31" in English',()=>{
  expect(title('en','claims.submit',CLAIM)).toBe(`Travel claim, RM 42.60, ${day('en','2026-10-31')}`);
  expect(title('en','claims.submit',{...CLAIM,claimType:'Travel Claim'})).toBe(`Travel claim, RM 42.60, ${day('en','2026-10-31')}`);
  expect(title('en','claims.cancel',CLAIM)).toBe(`Cancel Travel claim, RM 42.60, ${day('en','2026-10-31')}`);
  expect(title('en','ess.profile.request',{profileChange:'address'})).toBe('Change your home address');
  expect(title('en','ess.profile.request',{profileChange:'emergency_contact'})).toBe('Change your emergency contact');
  expect(title('en','ess.profile.request',{profileChange:'dependant'})).toBe('Add a dependant');
  expect(title('en','ess.profile.request',{profileChange:'bank',bankName:'Maybank',accountEnding:'5678'})).toBe('Change your bank account to Maybank, ending 5678');
 });
 it.each(['ms','zh','vi','ta','th'])('%s',locale=>{
  for(const action of ['claims.submit','claims.cancel']){const shown=title(locale,action,CLAIM)!;
   expect(shown).toContain('Travel');expect(shown).toContain('42.60');expect(shown).toContain(day(locale,'2026-10-31'));expect(shown).not.toMatch(/[{}]/);}
  const bank=title(locale,'ess.profile.request',{profileChange:'bank',bankName:'Maybank',accountEnding:'5678'})!;
  expect(bank).toContain('Maybank');expect(bank).toContain('5678');expect(bank).not.toMatch(/[{}]/);
  for(const change of ['address','emergency_contact','dependant'])expect(title(locale,'ess.profile.request',{profileChange:change})).not.toBe(title('en','ess.profile.request',{profileChange:change}));
 });
 it('keeps the generic title for a card without its facts or for another action',()=>{
  const t=()=>{throw Error('not called');},format=()=>{throw Error('not called');};
  expect(ownChangeCardTitle({what:{action:'claims.submit'},facts:{claimType:'Travel',incurredOn:'2026-10-31'}},t,format)).toBeNull();
  expect(ownChangeCardTitle({what:{action:'claims.submit'},facts:{...CLAIM,amount:'42.6'}},t,format)).toBeNull();
  expect(ownChangeCardTitle({what:{action:'ess.profile.request'},facts:{profileChange:'bank',bankName:'Maybank'}},t,format)).toBeNull();
  expect(ownChangeCardTitle({what:{action:'leave.apply'},facts:CLAIM},t,format)).toBeNull();
 });
 it('defines every title, check, outcome and action label in all six AI Centre catalogues',()=>{
  const checks=[...new Set(OWN_CHANGE_ACTIONS.flatMap(action=>action.checks.map(check=>check.check)))];
  const outcomes=['claim_submitted_if_checks_pass','claim_draft_receipt_needed','claim_cancelled_now','hr_approval_required','hr_verification_required'];
  const english=(en as unknown as Conversation).aiCentre.conversation;
  for(const [locale,messages] of Object.entries(CATALOGUES)){
   const conversation=(messages as unknown as Conversation).aiCentre.conversation;
   for(const key of OWN_CHANGE_TITLE_KEYS){expect(typeof conversation[key],locale+' '+key).toBe('string');if(locale!=='en')expect(conversation[key],locale+' '+key).not.toBe(english[key]);}
   for(const key of checks)expect(typeof conversation.checks[key],locale+' check '+key).toBe('string');
   for(const key of outcomes)expect(typeof conversation.outcomes[key],locale+' outcome '+key).toBe('string');
   for(const key of ['claims_submit','claims_cancel','ess_profile_request'])expect(typeof conversation.actions[key],locale+' action '+key).toBe('string');
  }
 });
});

describe('Confirm and Edit refuse before any read',()=>{
 const SECRET='fictional-proposal-signing-secret-0123456789abcdef';
 const tenantId=randomUUID(),userId=randomUUID(),personId=randomUUID(),employmentId=randomUUID(),actionId=randomUUID();
 const caller={tenantId,userId,personId,roles:['employee']} as unknown as SessionContext;
 const created=new Date('2026-11-03T01:00:00.000Z'),during=new Date(created.getTime()+60_000);
 const draft=(action='claims.submit',route='/assistant/claims'):ProposalDraft=>({what:{action,contractVersion:1,entity:'claim_request',effect:'create',selectors:{incurredOn:'2026-10-31'},reviewedDigest:'a'.repeat(64)},
  forWhom:{tenantId,subject:'own_employment',subjectId:employmentId},authority:{kind:'person',tenantId,userId,personId},
  checks:[{check:'claim_draft_reviewed',owner:'core/assistant-actions/own-claim-source.ts#prepareOwnClaimDraftSourceTx',ruleVersion:null,result:'pass'}],
  review:{route,href:route+'?review='+actionId,reference:actionId},facts:{...CLAIM,outcome:'claim_submitted_if_checks_pass'},
  createdAt:created.toISOString(),expiresAt:new Date(created.getTime()+600_000).toISOString()});
 beforeEach(()=>vi.stubEnv('TERAS_PROPOSAL_SECRET',SECRET));
 afterEach(()=>vi.unstubAllEnvs());
 it('needs an explicit Confirm, a signature that verifies, an unexpired proposal and the same person',async()=>{
  const proposal=issueProposal(draft());
  for(const confirm of [undefined,null,false,'yes',1,{}])expect(await confirmOwnChangeProposal(caller,{proposal,confirm},during)).toEqual({kind:'refused',reason:'not_confirmed'});
  // The amount on the card is signed: changing it breaks the signature.
  const forged=JSON.parse(JSON.stringify(proposal));forged.body.facts.amount='4.26';
  expect(await confirmOwnChangeProposal(caller,{proposal:forged,confirm:true},during)).toEqual({kind:'refused',reason:'signature'});
  expect(await editOwnChangeProposal(caller,forged,during)).toEqual({ok:false,reason:'signature'});
  expect(await confirmOwnChangeProposal({...caller,personId:randomUUID()} as SessionContext,{proposal,confirm:true},during)).toEqual({kind:'refused',reason:'authority_mismatch'});
  expect(await confirmOwnChangeProposal({...caller,userId:randomUUID()} as SessionContext,{proposal,confirm:true},during)).toEqual({kind:'refused',reason:'authority_mismatch'});
  expect(await confirmOwnChangeProposal({...caller,tenantId:randomUUID()} as SessionContext,{proposal,confirm:true},during)).toEqual({kind:'refused',reason:'authority_mismatch'});
  expect(await editOwnChangeProposal({...caller,personId:randomUUID()} as SessionContext,proposal,during)).toEqual({ok:false,reason:'authority_mismatch'});
  expect(await confirmOwnChangeProposal(caller,{proposal,confirm:true},new Date(Date.parse(proposal.body.expiresAt)))).toEqual({kind:'refused',reason:'expired'});
  vi.stubEnv('TERAS_PROPOSAL_SECRET','');
  expect(await confirmOwnChangeProposal(caller,{proposal,confirm:true},during)).toEqual({kind:'refused',reason:'unavailable'});
 });
 it('refuses a proposal of another action, or one that names another review route',async()=>{
  for(const proposal of [issueProposal(draft('leave.apply','/assistant/leave')),issueProposal(draft('claims.submit','/assistant/profile')),issueProposal(draft('ess.profile.request','/assistant/claims'))]){
   expect(await confirmOwnChangeProposal(caller,{proposal,confirm:true},during)).toEqual({kind:'refused',reason:'wrong_action'});
   expect(await editOwnChangeProposal(caller,proposal,during)).toEqual({ok:false,reason:'wrong_action'});
  }
  expect(await confirmOwnChangeProposal(caller,{proposal:{body:{}},confirm:true},during)).toEqual({kind:'refused',reason:'malformed'});
 });
});
