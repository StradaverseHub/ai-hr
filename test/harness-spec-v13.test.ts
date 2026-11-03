/** Spec v13 (AI v2 Phase 1, slice 1): the capability catalogue rules (W1), claims and profile details and attendance dates
 * (W2), and fewer model steps (aiv2-speed-findings-20261103, causes 1a and 1b). The deterministic parts: the version and its
 * digest, the offer keeping product_capabilities on a gated turn, the role note naming it, each new instruction exactly once
 * with nothing left that contradicts it, and suggest_action's description naming the declared actions' purposes. Scripted
 * model and fictional tools; no provider. Whether a model follows the text is measured by the scored evaluation. */
import {describe,expect,it} from 'vitest';
import type {SessionContext} from '../db/client';
import {HARNESS_SPEC,HARNESS_SPEC_DIGESTS,harnessSpecDigest} from '../core/harness/spec';
import {HARNESS_TEST_ONLY,offerFor,roleNoteFor,runTurn} from '../core/harness/runner';
import {InMemoryTaskMemoryStore} from '../core/harness/memory';
import {suggestDescription,type ToolBinding,type ToolProvider} from '../core/harness/tools';
import {PRODUCT_CAPABILITIES_SPEC} from '../core/product-context/capability-catalogue';
import {HARNESS_VOCABULARY} from '../core/improvement/signals';
import {fakeTools} from './harness-ratchet/fake-tools';
import {scriptedModel} from './harness-ratchet/scripted-model';

const employee:SessionContext={tenantId:'00000000-0000-4000-8000-0000000000aa',userId:'00000000-0000-4000-8000-0000000000bb',personId:'00000000-0000-4000-8000-0000000000cc',
 roles:['employee'],grants:[{role:'employee',companyId:null}]};
const SCOPE={companyId:'00000000-0000-4000-8000-0000000000dd',locale:'en'};
const instructions=HARNESS_SPEC.instructions as readonly string[];
const count=(pattern:RegExp)=>instructions.filter(line=>pattern.test(line)).length;

/** A fictional product_capabilities binding beside fakeTools' own, with what it was asked. */
function withCapabilities(base:ToolProvider,asked:Record<string,unknown>[]):ToolProvider{
 const binding:ToolBinding={name:'product_capabilities',kind:'context',entity:'product_capability',spec:PRODUCT_CAPABILITIES_SPEC,identifierInputs:[],
  async run(input){asked.push({...input});return{ok:true,content:{ok:true,entries:[],returnedRows:0,totalRows:0,note:'This person has nothing of this kind in the product.'}};}};
 return async(ctx,scope,actions)=>{const candidates=await base(ctx,scope,actions);return{...candidates,bindings:[...candidates.bindings,binding]};};
}

describe('spec v13',()=>{
 it('is version 13 with its digest recorded, and every earlier digest is kept',()=>{
  expect(HARNESS_SPEC.version).toBe(13);expect(HARNESS_SPEC_DIGESTS[13]).toBe(harnessSpecDigest());
  expect(HARNESS_SPEC_DIGESTS[12]).toBe('c5fa36868fa6a153aefef022237df18c9a0bcb2184250c68b219a3af1c41a230');
  expect(Object.keys(HARNESS_SPEC_DIGESTS).map(Number)).toEqual([1,2,3,4,5,6,7,8,9,10,11,12,13]);
 });
 it('keeps product_capabilities on a gated turn as a public context tool, and the triage copy says the same',()=>{
  expect(HARNESS_SPEC.offer.publicContextTools).toEqual(['product_destinations','product_guidance','available_actions','product_capabilities']);
  expect(HARNESS_SPEC.offer.actionTools).toEqual(['available_actions','suggest_action']);
  expect(HARNESS_VOCABULARY.publicContextTools).toEqual(HARNESS_SPEC.offer.publicContextTools);
  const bind=(name:string,kind:ToolBinding['kind']):ToolBinding=>({name,kind,entity:null,spec:{name,description:name,inputSchema:{type:'object'}} as ToolBinding['spec'],identifierInputs:[],async run(){return{ok:true,content:null};}});
  const bindings=[bind('product_capabilities','context'),bind('approval_queue','context'),bind('my_leave_balances','read'),bind('suggest_action','suggest')];
  const names=(gate:Parameters<typeof offerFor>[1])=>offerFor(bindings,gate).map(binding=>binding.name);
  expect(names({privateReads:true,actions:true})).toEqual(['product_capabilities','approval_queue','my_leave_balances','suggest_action']);
  // About another person: no private read and no private context, but the caller's own capabilities stay.
  expect(names({privateReads:false,actions:true,reason:'other_person'})).toEqual(['product_capabilities','suggest_action']);
  // A file: no action either, so nothing can be suggested; the catalogue still says what is theirs (open, not prepare).
  expect(names({privateReads:false,actions:false,reason:'attachment'})).toEqual(['product_capabilities']);
  // A surface's own narrowing still wins.
  expect(offerFor(bindings,{privateReads:true,actions:true},['my_leave_balances']).map(binding=>binding.name)).toEqual(['my_leave_balances']);
 });
 it('offers and runs it on a turn about another person, with no private read',async()=>{
  const asked:Record<string,unknown>[]=[],{provider,dispatched}=fakeTools({});
  const model=scriptedModel([{calls:[{name:'product_capabilities',args:{kind:'import'}}]},{final:{reply:'Importing is not available to you here.',mode:'refuse'}}]);
  const result=await runTurn({enabled:HARNESS_TEST_ONLY,ctx:employee,conversationId:'conversation-v13',question:'Can you import Siti\'s leave balance?',scope:SCOPE,model,
   memory:new InMemoryTaskMemoryStore(),tools:withCapabilities(provider,asked)});
  expect(result.trace.gate.reason).toBe('other_person');
  expect(model.requests[0].tools.map(tool=>tool.name).sort()).toEqual(['available_actions','final_answer','product_capabilities','product_destinations','product_guidance','suggest_action']);
  expect(result.trace.calls.map(call=>[call.tool,call.status])).toEqual([['product_capabilities','ok']]);
  expect(asked).toEqual([{kind:'import'}]);expect(dispatched).toEqual([]);expect(result.reads).toEqual(['product_capabilities']);
  expect(result.reply).toBe('Importing is not available to you here.');
 });
 it('names product_capabilities in the role note every caller gets',()=>{
  expect(HARNESS_SPEC.roleNote.tools).toBe('What they may see or change here is exactly what the offered tools, available_actions and product_capabilities allow: check those before declining, and never offer more than they return.');
  expect(roleNoteFor(employee).endsWith(HARNESS_SPEC.roleNote.tools)).toBe(true);
 });
});

describe('spec v13 instructions',()=>{
 it('answers "what can you help with" from product_capabilities, naming nothing it does not list',()=>{
  expect(instructions).toContain('When asked what you can help with, call product_capabilities with no filter. Answer with four to six short bullets of what you can do for this person in their role, drawn from its areas, then one example question they could ask. Never name anything it does not list.');
 });
 it('asks one numbered question from the catalogue when a request could mean several things, never guessing',()=>{
  expect(instructions).toContain('When a request could mean more than one thing this person can do (such as "help me import data"), call product_capabilities with the matching kind or area. Ask one short question with its entries numbered by title, grouped by area when there are more than six; never guess which they meant.');
  // The v9 rule it replaces, which asked only from available_actions, is gone.
  expect(count(/could mean more than one action/)).toBe(0);
 });
 it('answers "can you …?" and "can I …?" from the catalogue: prepare, open, or not available',()=>{
  const line=instructions.find(row=>row.startsWith('Before answering "can you …?" or "can I …?"'));
  expect(line).toBe('Before answering "can you …?" or "can I …?", call product_capabilities. For an entry with mode prepare, start with "Yes, I can …" and call suggest_action. For mode open, say they can do it on its page and link the page it gives; for an action, call suggest_action instead, so its card opens that page. When nothing it lists fits, say in one line that it is not available to them here.');
  // Consistent with v11: an action's page comes with its card and is never linked in the text, and "I've prepared …"
  // is still only for a card this turn prepared.
  expect(count(/Do not link that page in your text; it comes with the card\./)).toBe(1);
  expect(count(/Only when its result says a review item is ready or a form is filled in, write "I've prepared … for you to review and confirm"/)).toBe(1);
  expect(count(/never open with "I can't" when an action is listed/)).toBe(1);
 });
 it('suggests claims and profile or bank changes with the person\'s own details and never a typed number',()=>{
  expect(instructions).toContain('For a claim, or a profile or bank change, suggest it with the details the person said. Never type a bank account, phone or identity number: the system reads them from the person\'s own message.');
 });
 it('gives attendance dates from today in Kuala Lumpur and times in 24-hour HH:MM, only as said',()=>{
  expect(instructions).toContain('For an attendance correction or overtime request, give the date worked out from today (Asia/Kuala_Lumpur) and times in 24-hour HH:MM, only as the person said them.');
  expect(instructions[0]).toBe('You are the HR Assistant inside an HR application. Today is {today} (Asia/Kuala_Lumpur).');
 });
 it('asks for independent lookups together and suggest_action directly when the action is clear',()=>{
  expect(instructions).toContain('When you need more than one lookup and none depends on another\'s result, request them all in the same step.');
  const change=instructions.find(row=>row.startsWith('To help with a change'))!;
  expect(change.startsWith('To help with a change, call suggest_action with the matching action from its list. Call available_actions first only when you need the purposes or the details an action collects to choose between actions. If suggest_action reports missing details,')).toBe(true);
  expect(count(/call available_actions and then suggest_action/)).toBe(0);
 });
});

describe('suggest_action\'s description (spec v13)',()=>{
 /** The eight actions the semantic model declares, written out by hand, with their catalogue purposes. */
 const DECLARED:Readonly<Record<string,string>>={
  'leave.apply':'Apply for leave for yourself.',
  'leave.cancel':'Cancel one of your own leave requests.',
  'approvals.leave.decide':'Review leave requests waiting for your approval.',
  'attendance.correction.request':'Request a correction to your own attendance record, such as a missed clock-in or clock-out.',
  'attendance.overtime.request':'Request overtime for yourself.',
  'claims.submit':'Submit an expense claim for yourself.',
  'claims.cancel':'Cancel one of your own expense claims.',
  'ess.profile.request':'Request a change to your own profile details for HR approval, such as your address, emergency contact, dependants or bank details.',
 };
 const rows=(ids:readonly string[])=>ids.map(id=>({id,purpose:DECLARED[id]??'A fictional purpose for '+id+'.'}));
 const base=suggestDescription([]);
 it('names each declared action this caller holds with its purpose, in catalogue order, and no other action',()=>{
  const all=suggestDescription(rows(['payroll.close',...Object.keys(DECLARED),'leave.edit']));
  expect(all).toBe(base+' What these actions do: '+Object.entries(DECLARED).map(([id,purpose])=>id+': '+purpose).join(' '));
  expect(all).not.toContain('payroll.close');expect(all).not.toContain('leave.edit');
  expect(suggestDescription(rows(['claims.cancel','leave.apply']))).toBe(base+' What these actions do: claims.cancel: '+DECLARED['claims.cancel']+' leave.apply: '+DECLARED['leave.apply']);
 });
 it('adds nothing when the caller holds none of them, and keeps the details rules and the number rule',()=>{
  expect(suggestDescription(rows(['payroll.close','payroll.reopen']))).toBe(base);
  expect(base).not.toContain('What these actions do');
  expect(base).toMatch(/^Point the person to the page where they complete and confirm one change: action is one of this person's action ids/);
  expect(base).toContain('For leave.apply, details may carry leaveType, startDate and endDate (YYYY-MM-DD)');
  expect(base).toContain('Never put a bank account, phone or identity number in details: the system reads those from the person\'s own message.');
 });
});
