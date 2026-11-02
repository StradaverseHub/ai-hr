/** REVIEW draft (would live at test/review/proposal-integrity.test.ts). Coverage for the signed proposal object:
 * forged, tampered, replayed-by-another-caller, expired, not-yet-valid, cross-tenant and mandate-authority proposals
 * are all refused by verifyProposal, and the review packets inherit the refusal. Pure: no database.
 * Expected to PASS on the current code. Static draft: not run locally. */
import {createHmac,randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {SessionContext} from '../../db/client';
import {canonicalJson,issueProposal,verifyProposal,ProposalUnavailable,type ProposalDraft} from '../../core/proposals/proposal';
import {leaveDecideReviewPackets} from '../../core/proposals/leave-decide';
import {renderProposalCard} from '../../core/proposals/card';

const SECRET='fictional-proposal-signing-secret-0123456789abcdef';
const tenantId=randomUUID(),userId=randomUUID(),personId=randomUUID();
const caller={tenantId,userId,personId,roles:['manager']} as SessionContext;
const now=new Date('2026-11-02T03:00:00Z');
const draft=(over:Partial<ProposalDraft>={}):ProposalDraft=>({
 what:{action:'approvals.leave.decide',contractVersion:1,entity:'leave_approval_step',effect:'decide',selectors:{startDate:'2026-11-10',decision:'approved'},reviewedDigest:'a'.repeat(64)},
 forWhom:{tenantId,subject:'assigned_request',subjectId:randomUUID()},authority:{kind:'person',tenantId,userId,personId},
 checks:[{check:'ai_controls_unpaused',owner:'core/assistant-action-pause.ts#assertAssistantActionUnpaused',ruleVersion:null,result:'pass'}],
 review:{route:'/assistant/approvals',href:`/assistant/approvals?review=${randomUUID()}`,reference:randomUUID()},
 createdAt:now.toISOString(),expiresAt:new Date(now.getTime()+600_000).toISOString(),...over});
const json=(value:unknown)=>JSON.parse(JSON.stringify(value));

beforeEach(()=>vi.stubEnv('TERAS_PROPOSAL_SECRET',SECRET));
afterEach(()=>vi.unstubAllEnvs());

describe('REVIEW pass: proposal integrity and binding',()=>{
 it('REVIEW pass: a proposal verifies only for its own caller, tenant and person',()=>{
  const proposal=json(issueProposal(draft()));
  expect(verifyProposal(proposal,caller,now).ok).toBe(true);
  for(const other of [{...caller,userId:randomUUID()},{...caller,personId:randomUUID()},{...caller,tenantId:randomUUID()},{...caller,personId:undefined}])
   expect(verifyProposal(proposal,other as SessionContext,now)).toEqual({ok:false,reason:'authority_mismatch'});
  // Confirming another person's proposal: the packets are refused too.
  expect(leaveDecideReviewPackets(proposal,{...caller,userId:randomUUID()} as SessionContext,now).ok).toBe(false);
  expect(renderProposalCard(proposal,{...caller,userId:randomUUID()} as SessionContext,now).ok).toBe(false);
 });
 it('REVIEW pass: any edit of the body breaks the signature; a re-bound authority cannot be re-signed without the secret',()=>{
  const proposal=json(issueProposal(draft()));
  const edits:((body:Record<string,any>)=>void)[]=[
   body=>{body.what.selectors.decision='rejected';},body=>{body.forWhom.subjectId=randomUUID();},body=>{body.review.reference=randomUUID();},
   body=>{body.what.reviewedDigest='b'.repeat(64);},body=>{body.expiresAt=new Date(now.getTime()+86_400_000).toISOString();},
  ];
  for(const edit of edits){const copy=json(proposal);edit(copy.body);expect(verifyProposal(copy,caller,now).ok).toBe(false);}
  // An attacker re-binds the authority to themself and signs with a guessed key.
  const forged=json(proposal);const attacker={...caller,userId:randomUUID(),personId:randomUUID()};
  forged.body.authority={kind:'person',tenantId,userId:attacker.userId,personId:attacker.personId};
  forged.signature.value=createHmac('sha256','not-the-secret-not-the-secret-not-the-secret').update('teras:proposal:v1\n'+canonicalJson(forged.body)).digest('hex');
  expect(verifyProposal(forged,attacker as SessionContext,now)).toEqual({ok:false,reason:'signature'});
  // Unknown keys are malformed, not silently ignored.
  expect(verifyProposal({...json(proposal),extra:true},caller,now)).toEqual({ok:false,reason:'malformed'});
 });
 it('REVIEW pass: expired, not-yet-valid and mandate-authority proposals are refused',()=>{
  const proposal=json(issueProposal(draft()));
  expect(verifyProposal(proposal,caller,new Date(now.getTime()+600_000))).toEqual({ok:false,reason:'expired'});
  expect(verifyProposal(proposal,caller,new Date(now.getTime()-60_000))).toEqual({ok:false,reason:'not_yet_valid'});
  const mandate=json(issueProposal(draft({authority:{kind:'mandate',tenantId,mandateId:randomUUID(),grantorPersonId:personId}})));
  expect(verifyProposal(mandate,caller,now)).toEqual({ok:false,reason:'authority_unsupported'});
  // A proposal whose authority tenant differs from its subject tenant is never issued.
  expect(()=>issueProposal(draft({forWhom:{tenantId:randomUUID(),subject:'assigned_request',subjectId:randomUUID()}}))).toThrow();
 });
 it('REVIEW pass: with no or a short secret nothing is issued or accepted',()=>{
  const proposal=json(issueProposal(draft()));
  vi.stubEnv('TERAS_PROPOSAL_SECRET','short');
  expect(()=>issueProposal(draft())).toThrow(ProposalUnavailable);
  expect(()=>verifyProposal(proposal,caller,now)).toThrow(ProposalUnavailable);
 });
});
