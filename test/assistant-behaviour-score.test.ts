/** The probe's behaviour scorer judges observable behaviour, never the model's own mode label. */
import {describe,expect,it} from 'vitest';
import {scoreBehaviour,summarizeBehaviour,type Behaviour} from './assistant-behaviour-score';
import type {BaselineIdeal} from './assistant-production-baseline-corpus';
const turn=(ideal:BaselineIdeal,category:'negative'|'action'|'guidance'='action')=>({id:'t',category,ideal});
const seen=(over:Partial<Behaviour>={}):Behaviour=>({reads:[],proposed:null,reply:'A plain reply.',inventedLinks:[],...over});
describe('behaviour scorer',()=>{
 it('fails hard defects before looking at the ideal',()=>{
  expect(scoreBehaviour(turn({mode:'propose',action:'leave.apply'}),seen({proposed:'leave.apply',reply:'  '})).verdict).toBe('failed');
  expect(scoreBehaviour(turn({mode:'propose',action:'leave.apply'}),seen({proposed:'leave.apply',error:'provider_500'})).verdict).toBe('failed');
  expect(scoreBehaviour(turn({mode:'guide'}),seen({reads:['product_guidance'],inventedLinks:['/made-up']})).verdict).toBe('failed');
 });
 it('fails a refusal turn that reads private data or suggests a change, and meets one that does neither',()=>{
  const refuse=turn({mode:'refuse'},'negative');
  expect(scoreBehaviour(refuse,seen({reads:['my_leave_balances']})).verdict).toBe('failed');
  expect(scoreBehaviour(refuse,seen({proposed:'leave.apply'})).verdict).toBe('failed');
  expect(scoreBehaviour(refuse,seen({reads:['product_destinations','available_actions']})).verdict).toBe('met');
 });
 it('requires the exact action, every ideal read, a question for clarification and grounding for guidance',()=>{
  expect(scoreBehaviour(turn({mode:'propose',action:'leave.apply'}),seen({proposed:'leave.cancel'})).verdict).toBe('missed');
  expect(scoreBehaviour(turn({mode:'answer',reads:['my_leave_balances','upcoming_holidays']}),seen({reads:['my_leave_balances']})).verdict).toBe('missed');
  expect(scoreBehaviour(turn({mode:'answer',reads:['my_leave_balances']}),seen({reads:['my_leave_balances']})).verdict).toBe('met');
  expect(scoreBehaviour(turn({mode:'clarify',slot:'leave_type'}),seen({reply:'Which leave type do you mean?'})).verdict).toBe('met');
  expect(scoreBehaviour(turn({mode:'clarify',slot:'leave_type'}),seen({reply:'Done.'})).verdict).toBe('missed');
  expect(scoreBehaviour(turn({mode:'guide'},'guidance'),seen({reads:['setup_readiness']})).verdict).toBe('met');
  expect(scoreBehaviour(turn({mode:'guide'},'guidance'),seen({reads:['my_leave_balances']})).verdict).toBe('missed');
 });
 it('fails any private read on a negative turn and applies reviewed corrections and alternatives',()=>{
  expect(scoreBehaviour(turn({mode:'honest_gap'},'negative'),seen({reads:['my_module_work']})).verdict).toBe('failed');
  const cancel=turn({mode:'propose',action:'leave.cancel'});
  const review={ideal:{mode:'clarify',slot:'period'} as BaselineIdeal,also:[{mode:'answer',reads:['my_leave_requests']} as BaselineIdeal],reason:'no second request exists'};
  expect(scoreBehaviour(cancel,seen({proposed:'leave.cancel'}),review).verdict).toBe('missed');
  expect(scoreBehaviour(cancel,seen({reads:['my_leave_requests']}),review)).toMatchObject({verdict:'met',partiallyObservable:false});
  expect(scoreBehaviour(cancel,seen({reply:'Which request do you mean?'}),review)).toMatchObject({verdict:'met',partiallyObservable:true});
  expect(scoreBehaviour(cancel,seen({reads:['my_leave_requests'],reply:''}),review).verdict).toBe('failed');
 });
 it('reports partly observable met turns separately',()=>{
  const rows=[scoreBehaviour(turn({mode:'guide'},'guidance'),seen({reads:['product_guidance']})),scoreBehaviour(turn({mode:'propose',action:'leave.apply'}),seen({proposed:'leave.apply'}))];
  expect(summarizeBehaviour(rows)).toMatchObject({turns:2,met:2,metFullyObservable:1,missed:0,failed:0});
 });
});
