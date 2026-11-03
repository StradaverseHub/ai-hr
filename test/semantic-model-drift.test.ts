/** ADR-0170 step 0b — the semantic model stays pinned to the live Assistant reads, the agent action registry
 * and the native owners it names. No database: owners are imported and checked for their declared export. */
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {describe,expect,it} from 'vitest';
import {ASSISTANT_TOOLS} from '../core/assistant-tools';
import {ASSISTANT_TOOL_CATALOGUE} from '../lib/ai/assistant-tool-catalogue';
import {AGENT_ACTIONS} from '../lib/ai/agent-action-registry';
import {SEMANTIC_ACTIONS,SEMANTIC_ENTITIES,SEMANTIC_READS} from '../core/semantic-model/entities';
import {NOT_YET_MODELLED_ACTIONS} from '../core/semantic-model/pending';
import {capabilityRegistry,contextToolSpecs,referencedPages} from '../core/semantic-model/generate';
import type {OwnerAnchor} from '../core/semantic-model/types';
import * as read from '../core/read';
import * as leaveProjection from '../core/assistant-leave-projection';
import * as claimsService from '../packs/claims/service';
import * as earningLines from '../core/payslip-earning-lines';
import * as moduleReaders from '../core/module-agent-readers';
import * as moduleSpecialists from '../lib/ai/module-specialists';
import * as leaveDecisionSource from '../core/assistant-actions/reviewed-leave-decision-source';
import * as ownLeaveActor from '../core/assistant-actions/own-leave-actor';
import * as aiGovernance from '../core/ai-governance';
import * as leaveService from '../packs/leave/service';
import * as ownLeaveStore from '../core/assistant-actions/own-leave-store';
import * as ownLeaveDigest from '../core/assistant-actions/own-leave-review-digest';
import * as ownLeaveContract from '../lib/assistant-actions/own-leave-contract';
import * as ownLeaveChange from '../core/assistant-actions/own-leave-change-source';
import * as leaveApplyProposal from '../core/proposals/leave-apply';
import * as leaveCancelProposal from '../core/proposals/leave-cancel';
import * as leaveDecideProposal from '../core/proposals/leave-decide';
import * as ownClaimSubmission from '../core/assistant-actions/own-claim-submission-source';
import * as ownClaimCancellation from '../core/assistant-actions/own-claim-cancellation-source';
import * as ownClaimDraft from '../core/assistant-actions/own-claim-source';
import * as ownProfileChange from '../core/assistant-actions/own-profile-change-source';
import * as profile from '../core/profile';
import * as profileEdit from '../core/profile-edit';
import * as claimSubmitProposal from '../core/proposals/claim-submit';
import * as claimCancelProposal from '../core/proposals/claim-cancel';
import * as profileChangeProposal from '../core/proposals/profile-change';

/** Literal imports only, so a new anchor file must be added here on purpose. */
const OWNER_MODULES:Readonly<Record<string,Record<string,unknown>>>={
 'core/read.ts':read,'core/assistant-leave-projection.ts':leaveProjection,'packs/claims/service.ts':claimsService,
 'core/payslip-earning-lines.ts':earningLines,'core/module-agent-readers.ts':moduleReaders,'lib/ai/module-specialists.ts':moduleSpecialists,
 'core/assistant-actions/reviewed-leave-decision-source.ts':leaveDecisionSource,'core/assistant-actions/own-leave-actor.ts':ownLeaveActor,
 'core/ai-governance.ts':aiGovernance,'packs/leave/service.ts':leaveService,'core/assistant-actions/own-leave-store.ts':ownLeaveStore,
 'core/assistant-actions/own-leave-review-digest.ts':ownLeaveDigest,'lib/assistant-actions/own-leave-contract.ts':ownLeaveContract,
 'core/assistant-actions/own-leave-change-source.ts':ownLeaveChange,'core/proposals/leave-apply.ts':leaveApplyProposal,
 'core/proposals/leave-cancel.ts':leaveCancelProposal,'core/proposals/leave-decide.ts':leaveDecideProposal,
 // AI v2 W2: own claims and own profile changes.
 'core/assistant-actions/own-claim-submission-source.ts':ownClaimSubmission,'core/assistant-actions/own-claim-cancellation-source.ts':ownClaimCancellation,
 'core/assistant-actions/own-claim-source.ts':ownClaimDraft,'core/assistant-actions/own-profile-change-source.ts':ownProfileChange,'core/profile.ts':profile,
 'core/profile-edit.ts':profileEdit,'core/proposals/claim-submit.ts':claimSubmitProposal,'core/proposals/claim-cancel.ts':claimCancelProposal,
 'core/proposals/profile-change.ts':profileChangeProposal,
};
const root=fileURLToPath(new URL('..',import.meta.url));
function resolveAnchor(anchor:OwnerAnchor):unknown{
 const [file,name]=anchor.split('#');
 expect(existsSync(root+file),anchor+' file').toBe(true);
 const owned=OWNER_MODULES[file];
 expect(owned,anchor+' module is not imported by this test').toBeDefined();
 return owned![name];
}
const functionAnchors=():OwnerAnchor[]=>[...SEMANTIC_ENTITIES.flatMap(entity=>entity.owners),
 ...SEMANTIC_ACTIONS.flatMap(action=>[action.service,action.guard,action.preparer,...action.checks.map(check=>check.owner),...(action.proposal?[action.proposal]:[])])];
const versionAnchors=():OwnerAnchor[]=>[...SEMANTIC_ENTITIES.flatMap(entity=>entity.ruleVersion?[entity.ruleVersion]:[]),
 ...SEMANTIC_ACTIONS.flatMap(action=>action.checks.flatMap(check=>check.ruleVersion?[check.ruleVersion]:[]))];
/** The drift rules themselves, as functions, so a deliberately drifted input proves they fail. */
const unmodelledReads=(names:readonly string[])=>names.filter(name=>!SEMANTIC_READS.some(row=>row.name===name));
const unaccountedActions=(ids:readonly string[])=>ids.filter(id=>!SEMANTIC_ACTIONS.some(row=>row.id===id)&&!NOT_YET_MODELLED_ACTIONS.includes(id));

describe('semantic model covers every live Assistant read and registry action',()=>{
 const readNames=ASSISTANT_TOOLS.map(tool=>tool.spec.name),actionIds:readonly string[]=AGENT_ACTIONS.map(action=>action.id);
 it('declares the twelve reads, one each, in registry order',()=>{
  expect(readNames).toHaveLength(12);
  expect(SEMANTIC_READS.map(row=>row.name)).toEqual(readNames);
  expect(unmodelledReads(readNames)).toEqual([]);
  expect(unmodelledReads([...readNames,'fictional_new_read'])).toEqual(['fictional_new_read']);
 });
 it('declares the three leave actions, the own claim and profile actions, and lists every other registry action as pending, shrink only',()=>{
  expect(SEMANTIC_ACTIONS.map(row=>row.id).sort()).toEqual(['approvals.leave.decide','claims.cancel','claims.submit','ess.profile.request','leave.apply','leave.cancel']);
  expect(unaccountedActions(actionIds)).toEqual([]);
  expect(unaccountedActions([...actionIds,'fictional.new.action'])).toEqual(['fictional.new.action']);
  expect(NOT_YET_MODELLED_ACTIONS.filter(id=>!actionIds.includes(id))).toEqual([]);
  expect(NOT_YET_MODELLED_ACTIONS.filter(id=>SEMANTIC_ACTIONS.some(row=>row.id===id))).toEqual([]);
  expect(new Set(NOT_YET_MODELLED_ACTIONS).size).toBe(NOT_YET_MODELLED_ACTIONS.length);
  expect(NOT_YET_MODELLED_ACTIONS.length).toBeLessThanOrEqual(65);
  expect(NOT_YET_MODELLED_ACTIONS.length+SEMANTIC_ACTIONS.length).toBe(actionIds.length);
 });
 it('matches each read\'s module and sensitivity to the Assistant read it describes',()=>{
  for(const [index,row] of SEMANTIC_READS.entries()){
   const entity=SEMANTIC_ENTITIES.find(candidate=>candidate.id===row.entity)!,tool=ASSISTANT_TOOLS[index];
   expect([row.name,entity.module,entity.sensitivity]).toEqual([tool.spec.name,tool.module,tool.sensitivity]);
  }
 });
 it('mirrors each declared action\'s registry entry',()=>{
  for(const action of SEMANTIC_ACTIONS){
   const entry=AGENT_ACTIONS.find(candidate=>candidate.id===action.id)!;
   expect({module:action.module,service:action.service,guard:action.guard,route:action.reviewRoute,inputs:action.humanInputs,actor:action.actor})
    .toEqual({module:entry.module,service:entry.service,guard:entry.permission.guard,route:entry.review.route,inputs:entry.humanInputs,actor:entry.permission.actor});
  }
 });
 it('generates read specs whose names and input schemas equal the production catalogue',()=>{
  const generated=contextToolSpecs();
  expect(generated.map(spec=>spec.name)).toEqual(ASSISTANT_TOOL_CATALOGUE.map(spec=>spec.name));
  for(const [index,spec] of generated.entries())expect(spec.inputSchema).toEqual(ASSISTANT_TOOL_CATALOGUE[index].inputSchema);
  expect(capabilityRegistry().map(row=>row.name)).toEqual([...readNames,...SEMANTIC_ACTIONS.map(action=>action.id)]);
 });
});

describe('every declared owner exists',()=>{
 it('resolves every owner, guard, preparer, check and proposal anchor to an exported function',()=>{
  const anchors=functionAnchors();expect(anchors.length).toBeGreaterThan(20);
  for(const anchor of anchors)expect(typeof resolveAnchor(anchor),anchor).toBe('function');
 });
 it('resolves every rule-version anchor to a defined export',()=>{
  const anchors=versionAnchors();expect(anchors).toContain('lib/assistant-actions/own-leave-contract.ts#OWN_LEAVE_CONTRACT_VERSION');
  for(const anchor of anchors)expect(resolveAnchor(anchor),anchor).not.toBeUndefined();
 });
 it('fails for an owner that does not exist',()=>{
  expect(()=>expect(typeof resolveAnchor('core/read.ts#fictionalMissingOwner')).toBe('function')).toThrow();
 });
});

describe('referenced pages and relations',()=>{
 it('names only real product pages',()=>{
  const pages=referencedPages();expect(pages).toEqual(expect.arrayContaining(['/assistant/leave','/assistant/approvals','/leave']));
  for(const page of pages)expect(existsSync(root+'app'+(page==='/'?'':page)+'/page.tsx'),page).toBe(true);
 });
 it('relates only declared entities, through a field one side declares, and leaves no entity unused',()=>{
  const names=(fields:readonly {name:string;of?:readonly {name:string}[]}[]):string[]=>fields.flatMap(field=>[field.name,...(field.of?names(field.of):[])]);
  for(const entity of SEMANTIC_ENTITIES)for(const relation of entity.relations){
   const target=SEMANTIC_ENTITIES.find(candidate=>candidate.id===relation.to);expect(target,entity.id+'->'+relation.to).toBeDefined();
   expect([...names(entity.fields),...names(target!.fields)],entity.id+' via '+relation.via).toContain(relation.via);
  }
  const used=new Set([...SEMANTIC_READS.map(row=>row.entity),...SEMANTIC_ACTIONS.map(row=>row.entity)]);
  expect(SEMANTIC_ENTITIES.filter(entity=>!used.has(entity.id)).map(entity=>entity.id)).toEqual([]);
 });
});
