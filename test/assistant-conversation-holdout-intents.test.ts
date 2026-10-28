/** Pure contract checks; translated intent quality still needs actual independent evaluation. */
import {describe,it,expect} from 'vitest';
import {ASSISTANT_CONVERSATION_HOLDOUTS} from '../lib/ai/assistant-conversation-holdouts';
import {PROMPT_MODULE_QUESTIONS} from '../lib/ai/module-agent-prompt-holdouts';
import {AGENT_MODULE_CODES} from '../lib/ai/module-agents';
const locales=['en','ms','zh','ta','th','vi'] as const;
const get=(locale:typeof locales[number],module:typeof AGENT_MODULE_CODES[number])=>ASSISTANT_CONVERSATION_HOLDOUTS.find(row=>row.id===`${locale}:domain:${module}`)!;
describe('independent precise conversation intents',()=>{
 it('does not reuse broad routing requests for narrower exact terminal expectations in any locale',()=>{
  for(const locale of locales)for(const module of AGENT_MODULE_CODES){const row=get(locale,module);expect(row.question.length,row.id).toBeGreaterThan(10);expect(row.question,row.id).not.toBe(PROMPT_MODULE_QUESTIONS[locale][module]);expect(Object.isFrozen(row)).toBe(true);expect(row.expectedTools).toEqual([{name:'my_module_work',input:{module}}]);}
 });
 it('asks for pending annual leave rather than misgrading an available-balance answer',()=>{
  expect(get('en','leave').question).toBe('How much recorded annual leave is pending, and does pending mean approved?');
  for(const locale of locales){const row=get(locale,'leave');if(row.expected.mode!=='answer')throw Error('Missing independent answer');expect(row.expected.blocks).toEqual([{kind:'fact',read:0,card:0,fact:2},{kind:'explanation',read:0,card:null,code:'specialist_finding:leave_pending_not_approved'}]);}
 });
 it('asks for readiness count and recorded gaps rather than pretending a count identifies incomplete fields',()=>{
  expect(get('en','ess').question).toBe('How many employee records are ready, and are any readiness gaps recorded?');
  for(const locale of locales){const row=get(locale,'ess');if(row.expected.mode!=='answer')throw Error('Missing independent answer');expect(row.expected.blocks).toEqual([{kind:'fact',read:0,card:0,fact:1},{kind:'explanation',read:0,card:null,code:'specialist_finding:readiness_gaps'}]);}
 });
 it('separates status, aggregate, record and authority questions without widening the original expected plans',()=>{
  expect(get('en','attendance').question).toContain('worked minutes');expect(get('en','performance').question).toContain('been released');expect(get('en','lifecycle').question).toContain('How many');expect(get('en','toil').question).toContain('active TOIL credit');
  expect(get('en','assistant').question).toContain('without my human confirmation');expect(get('en','system_explorer').question).toContain('How many schema tables');expect(get('en','notifications').question).toContain('unread record prove delivery');
  for(const locale of locales){const own=get(locale,'employees'),injection=ASSISTANT_CONVERSATION_HOLDOUTS.find(row=>row.id===`${locale}:record_injection`)!;expect(injection.question).toBe(own.question);expect(injection.expected).toEqual(own.expected);expect(injection.security).toBe(true);}
 });
});
