/** @vitest-environment jsdom */
/** Authored UNRUN display contracts only. Mock management metadata/actions prove neither native
 * authorization, real model quality, provider capability nor successful promotion. */
import {cleanup,render,screen,within} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import viCopy from '../messages/vi.json';
const state=vi.hoisted(()=>({locale:'en'}));
// A separate statement: vitest hoists the WHOLE declaration holding vi.hoisted above the JSON imports.
const copies:Record<string,unknown>={en,ms,zh,ta,th,vi:viCopy};
vi.mock('next-intl/server',()=>({getLocale:async()=>state.locale,getTranslations:async(namespace:string)=>(key:string,args:Record<string,string|number>={})=>{let value:unknown=copies[state.locale];for(const part of [...namespace.split('.'),...key.split('.')])value=(value as Record<string,unknown>)[part];if(typeof value!=='string')throw Error('Missing translated governance label');return value.replace(/\{(\w+)\}/g,(_all,key:string)=>String(args[key]??''));}}));
vi.mock('../app/assistant/agent-review-actions',()=>({createAgentCandidateAction:vi.fn(),evaluateAgentCandidateAction:vi.fn(),promoteAgentCandidateAction:vi.fn(),rollbackAgentCandidateAction:vi.fn(),tryAgentCandidateAction:vi.fn(),createConversationCandidateAction:vi.fn(),evaluateConversationCandidateAction:vi.fn(),promoteConversationCandidateAction:vi.fn(),eraseConversationMetadataAction:vi.fn()}));
import {ModuleAgentReview} from '../components/assistant/module-agent-review';
import {MODULE_AGENT_SOURCE_DIGEST} from '../lib/ai/module-agent-source-manifest';
import {createConversationCandidateAction,evaluateConversationCandidateAction,promoteConversationCandidateAction} from '../app/assistant/agent-review-actions';
type View=Parameters<typeof ModuleAgentReview>[0]['view'];
const id='00000000-0000-4000-8000-000000000001';
function view(own=false):View{return{sourceDigest:MODULE_AGENT_SOURCE_DIGEST,nextVersion:3,lastTrial:null,ownSignalChoices:[],ownNativeSignalChoices:[],nativeSignalChoicesTruncated:false,candidates:[],promotions:[],conversationCandidates:[{id,version:2,own,progress:null}],conversationPromotions:[]};}
beforeEach(()=>{state.locale='en';vi.clearAllMocks();});afterEach(cleanup);
describe('separate main-conversation governance controls',()=>{
 it.each(['en','ms','zh','ta','th','vi'])('%s names main conversation independently from routing and requires unchecked bounded synthetic consent',async locale=>{
  state.locale=locale;const copy=(copies[locale] as typeof en).assistant.workspace.conversationGovernance;render(await ModuleAgentReview({view:view()}));const region=screen.getByRole('region',{name:copy.title}),scoped=within(region);expect(region.textContent).toContain(copy.scope);const consent=scoped.getByRole('checkbox',{name:copy.consent}) as HTMLInputElement;expect(consent.checked).toBe(false);expect(consent.required).toBe(true);const button=scoped.getByRole('button',{name:copy.evaluate});expect(button.className).toContain('min-h-11');expect(new FormData(button.closest('form')!).get('candidateId')).toBe(id);expect(createConversationCandidateAction).not.toHaveBeenCalled();expect(evaluateConversationCandidateAction).not.toHaveBeenCalled();expect(promoteConversationCandidateAction).not.toHaveBeenCalled();
 });
 it('offers only source-owned variants and fixed candidate/version fields, not a raw prompt or permission knobs',async()=>{
  render(await ModuleAgentReview({view:view()}));const copy=en.assistant.workspace.conversationGovernance,region=screen.getByRole('region',{name:copy.title}),create=within(region).getByRole('button',{name:copy.create}).closest('form')!;expect(Array.from(create.querySelectorAll('option')).map(option=>option.value)).toEqual(['baseline_v1','focused_v1']);expect(new FormData(create).get('variant')).toBe('focused_v1');expect(new FormData(create).get('version')).toBe('3');expect(create.querySelector('textarea')).toBeNull();expect([...new FormData(create).keys()].sort()).toEqual(['variant','version']);
 });
 it('does not offer self evaluation/promotion and keeps missing progress visibly unknown',async()=>{
  render(await ModuleAgentReview({view:view(true)}));const copy=en.assistant.workspace.conversationGovernance,region=screen.getByRole('region',{name:copy.title});expect(region.textContent).toContain(copy.unknown);expect(within(region).queryByRole('button',{name:copy.evaluate})).toBeNull();expect(within(region).queryByRole('button',{name:copy.promote})).toBeNull();expect(within(region).getByRole('button',{name:copy.erase})).toBeTruthy();
 });
 it('shows explicit zero credit as zero and unknown metrics as unknown without claiming a saving or quality gain',async()=>{
  const input=view(),stats={cases:1,correct:1,securityFailures:0,readCount:1,elapsedMs:null,p50Ms:null,p95Ms:null,inputTokens:null,outputTokens:null,costCredits:0};input.conversationCandidates[0].progress={completedCases:1,totalCases:192,state:'incomplete',knownFailures:0,comparison:{complete:false,baseline:stats,candidate:stats,qualityImproved:false,resources:'observations-only'}};render(await ModuleAgentReview({view:input}));const region=screen.getByRole('region',{name:en.assistant.workspace.conversationGovernance.title});expect(region.textContent).toContain('Account credits 0');expect(region.textContent).toContain(en.assistant.workspace.conversationGovernance.unknown);expect(region.textContent).toContain(en.assistant.workspace.agentReview.qualityPending);
 });
});
