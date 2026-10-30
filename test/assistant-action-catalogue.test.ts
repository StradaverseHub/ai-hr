/** Review R6 (ADR-0151 §4.3, §4.6a): the chat proposal catalogue is DERIVED from the agent action registry and
 * filtered per caller — caller authority ∩ registry ∩ tier ∩ switches and pauses — and its prompt block keeps the
 * prefix-caching order. Pure contract cases plus the core actor mapping; no provider, store or database. */
import {describe,expect,it,vi} from 'vitest';
vi.mock('../core/ai-governance',()=>({assertAiActionUnpausedTx:vi.fn(),assertAgentActionUnpausedTx:vi.fn()}));
vi.mock('../core/assistant-readable-modules',()=>({assistantReadableModules:()=>['leave','claims','attendance','approvals']}));
import {AGENT_ACTIONS,getAgentAction} from '../lib/ai/agent-action-registry';
import {ASSISTANT_PROPOSABLE_ACTIONS,ASSISTANT_PROPOSAL_FALLBACK,ASSISTANT_PROPOSAL_HINT_KEYS,ASSISTANT_PROPOSAL_MODULE,ASSISTANT_PROPOSAL_PROTOCOL} from '../lib/ai/assistant-action-proposal-hints';
import {AGENT_ACTION_ACTORS,ASSISTANT_CHAT_ACTIONS,ASSISTANT_CHAT_PAUSE_KEYS,CHAT_PROPOSABLE_TIERS,CLOSED_PROPOSAL_CALLER,assistantProposalCatalogue,assistantProposalCatalogueBlock,syntheticAssistantProposalCaller,type AssistantProposalCaller} from '../lib/ai/assistant-action-catalogue';
import {ASSISTANT_CONVERSATION_SYSTEM,buildAssistantConversationSystem} from '../lib/ai/assistant-conversation-system';
import {AGENT_MODULE_CODES} from '../lib/ai/module-agents';
import {assertAiActionUnpausedTx,assertAgentActionUnpausedTx} from '../core/ai-governance';
import {assistantActionActors,assistantProposalCallerTx,ProposalCallerUnavailableError} from '../core/assistant-action-catalogue';
import {AiAllowanceError,AiGatewayError} from '../lib/ai/types';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import type {SessionContext,Tx} from '../db/client';

const everyone:AssistantProposalCaller={readableModules:[...AGENT_MODULE_CODES],actors:[...AGENT_ACTION_ACTORS],pausedKeys:[]};
const with_=(patch:Partial<AssistantProposalCaller>):AssistantProposalCaller=>({...everyone,...patch});

describe('the catalogue is derived from the registry',()=>{
 it('contains exactly the registry entries with an inline card, implemented phases and a Confirm/Approve tier, in registry order',()=>{
  const expected=AGENT_ACTIONS.filter(action=>Object.hasOwn(ASSISTANT_PROPOSAL_HINT_KEYS,action.id)).map(action=>action.id);
  expect(ASSISTANT_CHAT_ACTIONS.map(action=>action.id)).toEqual(expected);
  // Every hint shape belongs to a registry entry the catalogue keeps: drift (a removed entry, a tier moved to
  // Handoff, a phase marked pending) fails here instead of silently dropping or keeping a card.
  expect([...ASSISTANT_CHAT_ACTIONS.map(action=>action.id)].sort()).toEqual([...ASSISTANT_PROPOSABLE_ACTIONS].sort());
  for(const action of ASSISTANT_CHAT_ACTIONS){
   expect(action.prepare.status,action.id).toBe('implemented');expect(action.confirm.status,action.id).toBe('implemented');
   expect(CHAT_PROPOSABLE_TIERS as readonly string[]).toContain(action.policy.tier);expect(action.store).not.toBe('human_workflow_only');
  }
  expect(assistantProposalCatalogue(everyone)).toEqual(expected);
 });
 it('reads each card’s module and review page from the registry, never a second list',()=>{
  for(const action of ASSISTANT_PROPOSABLE_ACTIONS){
   expect(ASSISTANT_PROPOSAL_MODULE[action],action).toBe(getAgentAction(action).module);
   expect(ASSISTANT_PROPOSAL_FALLBACK[action].split('?')[0],action).toBe(getAgentAction(action).review.route.split('?')[0]);
  }
 });
 it('never offers an Automatic, Handoff or human-workflow-only entry, whatever the caller holds',()=>{
  const offered=new Set(assistantProposalCatalogue(everyone));
  for(const action of AGENT_ACTIONS){const tier:string=action.policy.tier;if(tier==='automatic'||tier==='handoff'||action.store==='human_workflow_only')expect(offered.has(action.id as never),action.id).toBe(false);}
  expect(offered.has('employees.import' as never)).toBe(false);expect(offered.has('payroll.close' as never)).toBe(false);
 });
});

describe('per-caller filtering: authority ∩ registry ∩ tier ∩ switches and pauses',()=>{
 it('drops actions whose module the caller cannot read',()=>{
  expect(assistantProposalCatalogue(with_({readableModules:['leave']}))).toEqual(['leave.cancel','leave.edit']);
  expect(assistantProposalCatalogue(with_({readableModules:['approvals']}))).toEqual(['approvals.claim.decide','approvals.attendance.decide','approvals.toil.decide']);
  expect(assistantProposalCatalogue(with_({readableModules:[]}))).toEqual([]);
 });
 it('drops actions whose actor class the caller does not hold',()=>{
  // Self-service only: own leave, claim and overtime changes, no assigned decisions.
  expect(assistantProposalCatalogue(with_({actors:['self']}))).toEqual(['leave.cancel','leave.edit','attendance.overtime.request','claims.cancel']);
  expect(assistantProposalCatalogue(with_({actors:['assigned_approver']}))).toEqual(['approvals.claim.decide','approvals.attendance.decide','approvals.toil.decide']);
  // An administrator role alone is not the person-bound actor any of these cards need.
  expect(assistantProposalCatalogue(with_({actors:['hr_admin','tenant_admin','payroll_admin','rewards_admin']}))).toEqual([]);
 });
 it('drops every action behind a paused key, and the key set is what the registry entries declare',()=>{
  expect(ASSISTANT_CHAT_PAUSE_KEYS).toEqual([...new Set(ASSISTANT_CHAT_ACTIONS.map(action=>action.pauseKey))]);
  expect(assistantProposalCatalogue(with_({pausedKeys:[...ASSISTANT_CHAT_PAUSE_KEYS]}))).toEqual([]);
 });
 it('fails closed on missing or malformed caller facts',()=>{
  for(const caller of[undefined,null,'everyone',{},CLOSED_PROPOSAL_CALLER,{readableModules:['leave']},{...everyone,actors:'self'},{...everyone,pausedKeys:null},
   {...everyone,readableModules:[1]},{...everyone,actors:Object.assign(Object.create({}),{length:0})}])
   expect(assistantProposalCatalogue(caller),JSON.stringify(caller)).toEqual([]);
 });
 it('ignores facts the registry does not know: an unknown module, actor or key adds nothing',()=>{
  expect(assistantProposalCatalogue({readableModules:['payroll_unlock','leave'],actors:['root','self'],pausedKeys:['not_a_key']})).toEqual(['leave.cancel','leave.edit']);
 });
 it('the synthetic evaluation caller holds every actor and no pause, for its fixture modules only',()=>{
  expect(assistantProposalCatalogue(syntheticAssistantProposalCaller(['claims']))).toEqual(['claims.cancel']);
  expect(assistantProposalCatalogue(syntheticAssistantProposalCaller())).toEqual(assistantProposalCatalogue(everyone));
 });
});

describe('prompt block and the prefix-caching order rule',()=>{
 it('lists only offered actions with their hint keys, and says none when nothing is offered',()=>{
  const block=assistantProposalCatalogueBlock(assistantProposalCatalogue(with_({readableModules:['claims']})));
  expect(block).toContain('claims.cancel {incurredOn?}');expect(block).not.toContain('leave.cancel');expect(block).not.toContain('approvals.');
  expect(assistantProposalCatalogueBlock([])).toContain(': none.');
  // Smuggled strings are not registry ids and never reach the block.
  expect(assistantProposalCatalogueBlock(['payroll.close','x {y}'] as never)).toBe(assistantProposalCatalogueBlock([]));
 });
 it('keeps the constant prefix first, then the strategy, then the per-caller catalogue',()=>{
  const offered=assistantProposalCatalogue(everyone),system=buildAssistantConversationSystem('fixture-strategy',offered);
  expect(system.slice(0,ASSISTANT_CONVERSATION_SYSTEM.length)).toEqual([...ASSISTANT_CONVERSATION_SYSTEM]);
  expect(system[ASSISTANT_CONVERSATION_SYSTEM.length]).toBe('fixture-strategy');
  expect(system.at(-1)).toBe(assistantProposalCatalogueBlock(offered));expect(system).toHaveLength(ASSISTANT_CONVERSATION_SYSTEM.length+2);
  // Two callers with different catalogues share every constant byte; only the last block differs.
  const other=buildAssistantConversationSystem('fixture-strategy',assistantProposalCatalogue(with_({actors:['self']})));
  expect(other.slice(0,-1)).toEqual(system.slice(0,-1));expect(other.at(-1)).not.toBe(system.at(-1));
  // The constant blocks name no action, so a caller's catalogue never leaks into the shared prefix.
  for(const action of ASSISTANT_PROPOSABLE_ACTIONS)expect(ASSISTANT_CONVERSATION_SYSTEM.join('\n')).not.toContain(action);
  expect(ASSISTANT_CONVERSATION_SYSTEM.join('\n')).toContain(ASSISTANT_PROPOSAL_PROTOCOL);
 });
 it('a per-action pause hides only that inline proposal',()=>{
  const paused=assistantProposalCatalogue(with_({pausedKeys:['hr_assistant:leave.cancel']}));
  expect(paused).not.toContain('leave.cancel');expect(paused).toContain('leave.edit');
 });
 it('is byte-stable for the same caller facts (no clock, locale or identifier bytes)',()=>{
  const once=buildAssistantConversationSystem('s',assistantProposalCatalogue(everyone)),twice=buildAssistantConversationSystem('s',assistantProposalCatalogue({...everyone}));
  expect(twice).toEqual(once);expect(once.at(-1)).not.toMatch(/\b20\d\d-\d\d-\d\d\b|[a-f0-9]{8}-[a-f0-9]{4}-/i);
 });
});

describe('current caller facts (core owner)',()=>{
 const base:SessionContext={tenantId:'fictional-tenant',userId:'fictional-user'};
 it('maps the session’s own person, roles and grants to registry actor classes',()=>{
  expect(assistantActionActors({...base,personId:'fictional-person',roles:['employee'],grants:[{role:'employee',companyId:null}]})).toEqual(['self','assigned_approver','assigned_tester']);
  expect(assistantActionActors({...base,personId:null,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]})).toEqual(['assigned_tester','hr_admin','tenant_admin','payroll_admin','rewards_admin']);
  expect(assistantActionActors({tenantId:'fictional-tenant'})).toEqual([]);
 });
 it('reads each pause fresh in a savepoint: a confirmed pause is paused, an unconfirmable control throws (never “stale”)',async()=>{
  const tx={transaction:vi.fn(async(work:(savepoint:unknown)=>Promise<unknown>)=>work({}))} as unknown as Tx;
  const ctx={...base,personId:'fictional-person',roles:['employee']};
  vi.mocked(assertAiActionUnpausedTx).mockResolvedValueOnce(undefined);
  expect(await assistantProposalCallerTx(tx,ctx)).toEqual({readableModules:['leave','claims','attendance','approvals'],actors:['self','assigned_approver','assigned_tester'],pausedKeys:[]});
  vi.mocked(assertAiActionUnpausedTx).mockRejectedValueOnce(new AiAllowanceError('paused'));
  const paused=await assistantProposalCallerTx(tx,ctx);expect(paused.pausedKeys).toEqual([...ASSISTANT_CHAT_PAUSE_KEYS]);expect(assistantProposalCatalogue(paused)).toEqual([]);
  expect(vi.mocked(assertAiActionUnpausedTx).mock.calls.map(call=>call[2])).toEqual([...ASSISTANT_CHAT_PAUSE_KEYS,...ASSISTANT_CHAT_PAUSE_KEYS]);
  // Could not check (controls unconfirmed, another allowance refusal, a broken savepoint): the owner throws, so
  // the replay shows a neutral retry instead of claiming the suggestion is out of date.
  for(const failure of[new AiGatewayError('AI action controls could not be confirmed.'),new AiAllowanceError('daily_limit'),Error('connection reset')]){
   vi.mocked(assertAiActionUnpausedTx).mockRejectedValueOnce(failure);
   await expect(assistantProposalCallerTx(tx,ctx)).rejects.toBeInstanceOf(ProposalCallerUnavailableError);
  }
 });
});

describe('client bundle boundary',()=>{
 it('the hint file loads no registry at runtime (type-only import), so client panels never pull the server registry through it',()=>{
  const source=readFileSync('lib/ai/assistant-action-proposal-hints.ts','utf8');
  const runtime=source.split('\n').filter(line=>/^import\s/.test(line)&&!/^import\s+type\s/.test(line));
  expect(runtime.length).toBeGreaterThan(0);for(const line of runtime)expect(line).not.toMatch(/agent-action-registry|assistant-action-catalogue|module-agent|\.\.\/core|server-only/);
 });
 it('no client component imports the catalogue, the registry or a server-only module directly',()=>{
  const files=execFileSync('git',['grep','-l',"^'use client'",'--','components','app'],{encoding:'utf8'}).trim().split('\n').filter(Boolean);
  expect(files.length).toBeGreaterThan(0);
  for(const file of files){
   const imports=readFileSync(file,'utf8').split('\n').filter(line=>/^import\s/.test(line)&&!/^import\s+type\s/.test(line));
   for(const line of imports)expect(line,file).not.toMatch(/assistant-action-catalogue|agent-action-registry|['"]server-only['"]/);
  }
 });
});
