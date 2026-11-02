/** ADR-0170 step 2 — the one card renderer, on fictional signed proposals for each of the three leave cards.
 * Pure: no database. A card renders only from a proposal that verifies for the caller, carries only the
 * permitted keys and facts, and no identifier (the review custody handle in `review.href` is the one handle). */
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {SessionContext} from '../db/client';
import {issueProposal,type ProposalDraft} from '../core/proposals/proposal';
import {PROPOSAL_CARD_KEYS,renderProposalCard} from '../core/proposals/card';
import {SEMANTIC_ACTIONS} from '../core/semantic-model/entities';

const SECRET='fictional-proposal-signing-secret-0123456789abcdef';
const UUID=/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const tenantId=randomUUID(),userId=randomUUID(),personId=randomUUID(),employmentId=randomUUID(),requestId=randomUUID(),reviewId=randomUUID();
const caller={tenantId,userId,personId,roles:['employee']} as unknown as SessionContext;
const created=new Date('2026-11-02T01:00:00.000Z'),expires=new Date(created.getTime()+600_000),during=new Date(created.getTime()+60_000);
const base=(action:string,effect:'create'|'withdraw'|'decide'):Pick<ProposalDraft,'authority'|'createdAt'|'expiresAt'>&{what:ProposalDraft['what']}=>({
 what:{action,contractVersion:1,entity:SEMANTIC_ACTIONS.find(row=>row.id===action)!.entity,effect,selectors:{startDate:'2026-11-03'},reviewedDigest:'a'.repeat(64)},
 authority:{kind:'person',tenantId,userId,personId},createdAt:created.toISOString(),expiresAt:expires.toISOString()});
const check=(name:string,ruleVersion:string|null=null)=>({check:name,owner:'core/read.ts#listLeaveRequests' as const,ruleVersion,result:'pass' as const});
const CARDS:Readonly<Record<string,ProposalDraft>>={
 apply:{...base('leave.apply','create'),forWhom:{tenantId,subject:'own_employment',subjectId:employmentId},
  checks:[check('deduction_and_balance'),check('review_contract','leave.apply/contract:1')],
  review:{route:'/assistant/leave',href:'/assistant/leave?review='+reviewId,reference:reviewId},
  facts:{leaveType:'Annual Leave',startDate:'2026-11-03',endDate:'2026-11-03',days:1,balanceAfter:9,outcome:'submitted_not_approved'}},
 cancelPending:{...base('leave.cancel','withdraw'),forWhom:{tenantId,subject:'own_employment',subjectId:employmentId},checks:[check('own_pending_request')],
  review:{route:'/assistant/leave',href:'/assistant/leave?review='+reviewId,reference:reviewId},
  facts:{leaveType:'Annual Leave',startDate:'2026-11-03',endDate:'2026-11-03',days:1,outcome:'withdrawn_now'}},
 cancelApproved:{...base('leave.cancel','withdraw'),forWhom:{tenantId,subject:'own_employment',subjectId:employmentId},checks:[check('own_approved_cancellable')],
  review:{route:'/leave',href:'/leave',reference:requestId},
  facts:{leaveType:'Annual Leave',startDate:'2026-11-03',endDate:'2026-11-05',days:3,cancelDates:['2026-11-04','2026-11-05'],outcome:'give_back_requested'}},
 decide:{...base('approvals.leave.decide','decide'),forWhom:{tenantId,subject:'assigned_request',subjectId:requestId},checks:[check('assigned_step_current')],
  review:{route:'/assistant/approvals',href:'/assistant/approvals?review='+reviewId,reference:reviewId},
  facts:{leaveType:'Annual Leave',startDate:'2026-11-03',endDate:'2026-11-03',days:1,balanceNow:10,othersAway:2,decision:'approved',outcome:'approval_if_native_checks_pass'}},
};
beforeEach(()=>vi.stubEnv('TERAS_PROPOSAL_SECRET',SECRET));
afterEach(()=>vi.unstubAllEnvs());
const card=(name:string)=>{const result=renderProposalCard(issueProposal(CARDS[name]),caller,during);if(!result.ok)throw Error(name+' refused: '+result.reason);return result.card;};

describe('one renderer for the three leave cards',()=>{
 it.each(Object.keys(CARDS))('renders %s with only the permitted keys, its declared purpose, and no identifier',name=>{
  const rendered=card(name),draft=CARDS[name];
  expect(Object.keys(rendered).sort()).toEqual([...PROPOSAL_CARD_KEYS]);
  expect(rendered).toMatchObject({kind:'teras.card',version:1,action:draft.what.action,what:SEMANTIC_ACTIONS.find(row=>row.id===draft.what.action)!.purpose,
   expiresAt:expires.toISOString(),review:{route:draft.review.route,href:draft.review.href},needsReview:[]});
  // The custody handle in the review link is the only handle on a card; no business identifier appears at all.
  const text=JSON.stringify({...rendered,review:{route:rendered.review.route}});
  expect(text).not.toMatch(UUID);
  for(const id of [tenantId,userId,personId,employmentId,requestId])expect(JSON.stringify(rendered)).not.toContain(id);
  expect(Object.keys(rendered.review).sort()).toEqual(['href','route']);
  for(const fact of rendered.facts)expect(Object.keys(fact).sort()).toEqual(['key','label','value']);
  expect(rendered.facts.map(fact=>fact.key).sort()).toEqual(Object.keys(draft.facts!).sort());
 });
 it('says who the change is for as a relation to the caller, and shows rule versions an owner publishes',()=>{
  expect(card('apply').forWhom).toBe('You');expect(card('decide').forWhom).toBe('A leave request assigned to you to decide');
  expect(card('apply').ruleVersions).toEqual(['leave.apply/contract:1']);expect(card('decide').ruleVersions).toEqual([]);
 });
 it('words facts from the closed vocabulary: balance, overlap, coverage, decision and outcome',()=>{
  const facts=Object.fromEntries(card('decide').facts.map(fact=>[fact.key,fact.value]));
  expect(facts).toEqual({leaveType:'Annual Leave',startDate:'2026-11-03',endDate:'2026-11-03',days:'1',balanceNow:'10',othersAway:'2',decision:'Approve',
   outcome:'The request is approved if the leave checks still pass.'});
  expect(Object.fromEntries(card('apply').facts.map(fact=>[fact.key,fact.value])).balanceAfter).toBe('9');
  expect(Object.fromEntries(card('cancelApproved').facts.map(fact=>[fact.key,fact.value])).cancelDates).toBe('2026-11-04, 2026-11-05');
 });
 it('has no card for a tampered, expired or other-person proposal',()=>{
  const proposal=issueProposal(CARDS.decide),forged=JSON.parse(JSON.stringify(proposal));forged.body.facts.decision='rejected';
  expect(renderProposalCard(forged,caller,during)).toEqual({ok:false,reason:'signature'});
  expect(renderProposalCard(proposal,caller,expires)).toEqual({ok:false,reason:'expired'});
  expect(renderProposalCard(proposal,{...caller,personId:randomUUID()} as SessionContext,during)).toEqual({ok:false,reason:'authority_mismatch'});
 });
 it('refuses a fact outside the vocabulary, such as a name or free text, at issue',()=>{
  expect(()=>issueProposal({...CARDS.decide,facts:{...CARDS.decide.facts,applicantName:'Fictional Person'} as never})).toThrow();
  expect(()=>issueProposal({...CARDS.decide,facts:{...CARDS.decide.facts,leaveType:'x'.repeat(65)}})).toThrow();
 });
 it('is one renderer: the card module names no action',()=>{
  const source=readFileSync(fileURLToPath(new URL('../core/proposals/card.ts',import.meta.url)),'utf8');
  for(const action of SEMANTIC_ACTIONS)expect(source,action.id).not.toContain("'"+action.id+"'");
 });
});
