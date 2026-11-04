/** ADR-0170 step 0b — the signed proposal object on fictional values: tamper detection, expiry, authority
 * binding, configuration, and the source rule that a proposal never applies a change. No database. */
import {randomUUID} from 'node:crypto';
import {readFileSync,readdirSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {SessionContext} from '../db/client';
import {OwnLeaveConfirmation} from '../lib/assistant-actions/own-leave-contract';
import {canonicalJson,issueProposal,ProposalUnavailable,verifyProposal,type ProposalDraft} from '../core/proposals/proposal';
import {leaveApplyCardHint,leaveApplyReviewPackets} from '../core/proposals/leave-apply';

const SECRET='fictional-proposal-signing-secret-0123456789abcdef';
const tenantId=randomUUID(),userId=randomUUID(),personId=randomUUID(),employmentId=randomUUID(),reviewId=randomUUID();
const caller={tenantId,userId,personId,roles:['employee']} as unknown as SessionContext;
const created=new Date('2026-11-02T01:00:00.000Z'),expires=new Date(created.getTime()+600_000),during=new Date(created.getTime()+60_000);
function draft(overrides:Partial<ProposalDraft>={}):ProposalDraft{
 return{what:{action:'leave.apply',contractVersion:1,entity:'leave_request',effect:'create',selectors:{date:'2026-11-03',durationType:'full_day'},reviewedDigest:'a'.repeat(64)},
  forWhom:{tenantId,subject:'own_employment',subjectId:employmentId},authority:{kind:'person',tenantId,userId,personId},
  checks:[{check:'deduction_and_balance',owner:'packs/leave/service.ts#previewLeaveDeduction',ruleVersion:null,result:'pass'},
   {check:'review_contract',owner:'core/assistant-actions/own-leave-review-digest.ts#ownLeaveReviewedDigest',ruleVersion:'leave.apply/contract:1',result:'pass'}],
  review:{route:'/assistant/leave',href:'/assistant/leave?review='+reviewId,reference:reviewId},
  createdAt:created.toISOString(),expiresAt:expires.toISOString(),...overrides};
}
const clone=<T>(value:T):T=>JSON.parse(JSON.stringify(value));

beforeEach(()=>vi.stubEnv('TERAS_PROPOSAL_SECRET',SECRET));
afterEach(()=>vi.unstubAllEnvs());

describe('signature',()=>{
 it('issues a frozen, versioned proposal that verifies for its own person',()=>{
  const proposal=issueProposal(draft());
  expect(proposal.body).toMatchObject({kind:'teras.proposal',version:1});expect(proposal.signature.alg).toBe('HMAC-SHA256');
  expect(Object.isFrozen(proposal)&&Object.isFrozen(proposal.body)&&Object.isFrozen(proposal.body.checks[0])).toBe(true);
  expect(verifyProposal(proposal,caller,during)).toEqual({ok:true,proposal});
  expect(verifyProposal(clone(proposal),caller,during).ok).toBe(true);
 });
 it.each([
  ['the reviewed effect',(p:any)=>{p.body.what.reviewedDigest='b'.repeat(64);}],
  ['the selected date',(p:any)=>{p.body.what.selectors.date='2026-11-04';}],
  ['the subject',(p:any)=>{p.body.forWhom.subjectId=randomUUID();}],
  ['the authority',(p:any)=>{p.body.authority.personId=randomUUID();}],
  ['a check result',(p:any)=>{p.body.checks[0].result='needs_review';}],
  ['a rule version',(p:any)=>{p.body.checks[1].ruleVersion='leave.apply/contract:2';}],
  ['the review reference',(p:any)=>{p.body.review.reference=randomUUID();}],
  ['the expiry',(p:any)=>{p.body.expiresAt=new Date(expires.getTime()+3_600_000).toISOString();}],
  ['the signature itself',(p:any)=>{p.signature.value=p.signature.value.replace(/^./,(c:string)=>c==='0'?'1':'0');}],
 ])('refuses a proposal whose %s was changed',(_label,tamper)=>{
  const forged=clone(issueProposal(draft()));tamper(forged);
  expect(verifyProposal(forged,caller,during)).toEqual({ok:false,reason:'signature'});
 });
 it('refuses a proposal signed with another secret, and an extra or malformed field',()=>{
  vi.stubEnv('TERAS_PROPOSAL_SECRET','fictional-other-signing-secret-0123456789abcdef');const foreign=issueProposal(draft());
  vi.stubEnv('TERAS_PROPOSAL_SECRET',SECRET);
  expect(verifyProposal(foreign,caller,during)).toEqual({ok:false,reason:'signature'});
  const proposal=issueProposal(draft());
  expect(verifyProposal({...clone(proposal),extra:true},caller,during)).toEqual({ok:false,reason:'malformed'});
  expect(verifyProposal({body:{...clone(proposal.body),note:'apply it'},signature:proposal.signature},caller,during)).toEqual({ok:false,reason:'malformed'});
  expect(verifyProposal(null,caller,during)).toEqual({ok:false,reason:'malformed'});
 });
 it('signs a canonical encoding, independent of key order',()=>{
  expect(canonicalJson({b:1,a:{d:[2,{f:1,e:0}],c:null}})).toBe('{"a":{"c":null,"d":[2,{"e":0,"f":1}]},"b":1}');
  const proposal=issueProposal(draft()),body=proposal.body;
  const reordered={signature:{value:proposal.signature.value,alg:proposal.signature.alg},
   body:Object.fromEntries(Object.entries(clone(body)).reverse())};
  expect(verifyProposal(reordered,caller,during).ok).toBe(true);
  expect(()=>canonicalJson({a:Number.NaN})).toThrow(ProposalUnavailable);expect(()=>canonicalJson({a:undefined})).toThrow(ProposalUnavailable);
 });
 it('fails closed without a configured secret of at least 32 bytes',()=>{
  const proposal=issueProposal(draft());
  vi.stubEnv('TERAS_PROPOSAL_SECRET','');expect(()=>issueProposal(draft())).toThrow(ProposalUnavailable);expect(()=>verifyProposal(proposal,caller,during)).toThrow(ProposalUnavailable);
  vi.stubEnv('TERAS_PROPOSAL_SECRET','short-fictional-secret');expect(()=>issueProposal(draft())).toThrow(ProposalUnavailable);
 });
 it('refuses to issue a proposal with a failed check or an expiry before creation',()=>{
  expect(()=>issueProposal(draft({checks:[{check:'deduction_and_balance',owner:'packs/leave/service.ts#previewLeaveDeduction',ruleVersion:null,result:'fail'}]}))).toThrow();
  expect(()=>issueProposal(draft({expiresAt:created.toISOString()}))).toThrow();
  expect(()=>issueProposal(draft({authority:{kind:'person',tenantId:randomUUID(),userId,personId}}))).toThrow();
 });
});

describe('expiry and authority',()=>{
 it('refuses at and after expiry, and before creation',()=>{
  const proposal=issueProposal(draft());
  expect(verifyProposal(proposal,caller,new Date(expires.getTime()-1)).ok).toBe(true);
  expect(verifyProposal(proposal,caller,expires)).toEqual({ok:false,reason:'expired'});
  expect(verifyProposal(proposal,caller,new Date(expires.getTime()+86_400_000))).toEqual({ok:false,reason:'expired'});
  expect(verifyProposal(proposal,caller,new Date(created.getTime()-60_000))).toEqual({ok:false,reason:'not_yet_valid'});
  expect(verifyProposal(proposal,caller,new Date(Number.NaN))).toEqual({ok:false,reason:'malformed'});
 });
 it.each([
  ['another login',{...caller,userId:randomUUID()}],
  ['another person',{...caller,personId:randomUUID()}],
  ['another tenant',{...caller,tenantId:randomUUID()}],
  ['a login with no person',{...caller,personId:undefined}],
 ])('refuses %s',(_label,other)=>{
  expect(verifyProposal(issueProposal(draft()),other as SessionContext,during)).toEqual({ok:false,reason:'authority_mismatch'});
 });
 it('refuses mandate authority until mandates exist',()=>{
  const proposal=issueProposal(draft({authority:{kind:'mandate',tenantId,mandateId:randomUUID(),grantorPersonId:personId}}));
  expect(verifyProposal(proposal,caller,during)).toEqual({ok:false,reason:'authority_unsupported'});
 });
});

describe('leave.apply renderers',()=>{
 it('renders the card hint shape and the review page\'s own packets from a verified proposal only',()=>{
  const proposal=issueProposal(draft());
  expect(leaveApplyCardHint(proposal)).toEqual({action:'leave.apply',hints:{date:'2026-11-03'},reviewHref:'/assistant/leave?review='+reviewId,expiresAt:expires.toISOString()});
  const result=leaveApplyReviewPackets(proposal,caller,during);
  if(!result.ok)throw Error('fictional proposal did not verify');
  expect(result.packets.reopen).toEqual({operation:'reopen',actionId:reviewId});
  expect(OwnLeaveConfirmation.parse(result.packets.confirm.confirmation)).toEqual({actionId:reviewId,contractVersion:1,reviewedDigest:'a'.repeat(64)});
  expect(leaveApplyReviewPackets(proposal,{...caller,personId:randomUUID()} as SessionContext,during)).toEqual({ok:false,reason:'authority_mismatch'});
  expect(leaveApplyReviewPackets(proposal,caller,expires)).toEqual({ok:false,reason:'expired'});
  const forged=clone(proposal);forged.body.what.reviewedDigest='c'.repeat(64);
  expect(leaveApplyReviewPackets(forged,caller,during)).toEqual({ok:false,reason:'signature'});
  expect(leaveApplyReviewPackets(issueProposal(draft({what:{...draft().what,action:'leave.cancel'}})),caller,during)).toEqual({ok:false,reason:'wrong_action'});
 });
});

describe('a proposal never applies a change',()=>{
 const root=fileURLToPath(new URL('..',import.meta.url));
 const files=(dir:string):string[]=>readdirSync(join(root,dir)).flatMap(name=>{const path=join(dir,name);
  return statSync(join(root,path)).isDirectory()?(name==='node_modules'||name.startsWith('.')?[]:files(path)):/\.(ts|tsx)$/.test(name)?[path]:[];});
 it('imports no write, confirmation or provider path',()=>{
  for(const file of files('core/proposals')){
   const text=readFileSync(join(root,file),'utf8');
   for(const forbidden of [/\brequestLeave\b/,/\bconfirmOwnLeaveReview\b/,/\bdecideLeave\b/,/\bcancelOwnLeaveTx\b/,/from '[^']*packs\/leave\/service'/,/lib\/ai\/providers\//,/from '[^']*\/assistant'/,
    // AI v2 W2: the own claim and profile preparers save a sealed review only; confirming is core/assistant-actions/own-change-proposal-confirm.ts.
    /\bconfirm(?:Claim|ClaimSubmission|Profile)ModuleActionReview\b/,/\bconfirmClaimCancellationReview\b/,/\bsubmitDraftClaims\b/,/\bcancelClaimTx\b/,/\brequestProfileChange\b/,/from '[^']*packs\/claims\/service'/,
    // AI v2 W2 slice 3: the assigned decision preparer saves a sealed review only; deciding is assigned-decision-proposal-confirm.ts.
    /\b(?:claim|attendance)DecisionReviews\.confirm\b/,/\bdecideClaimTx\b/,/\bdecideAttendanceCorrection\b/,
    // AI v2 slice 3: the chat import preparer previews only; committing is core/chat-import/confirm.ts.
    /\bcommitLeaveImport\b/,/\bcommitEmployeeImport\w*\b/,/\bconfirmPayrollHistoryUpload\b/,/\bcommitClockingImport\b/,/from '[^']*chat-import\/confirm'/])
    expect(text,file+' '+forbidden).not.toMatch(forbidden);
  }
 });
 it('is issued only by the declared native preparers',()=>{
  const callers=['core','app','lib','packs'].flatMap(files).filter(file=>/\bissueProposal\(/.test(readFileSync(join(root,file),'utf8')));
  expect(callers.sort()).toEqual(['core/proposals/assigned-decide.ts','core/proposals/attendance-request.ts','core/proposals/chat-import.ts','core/proposals/claim-cancel.ts','core/proposals/claim-submit.ts','core/proposals/leave-apply.ts','core/proposals/leave-cancel.ts','core/proposals/leave-decide.ts','core/proposals/letter-request.ts','core/proposals/profile-change.ts','core/proposals/proposal.ts','core/proposals/toil-request.ts']);
 });
});
