/** Finite local semantics and fact-kind closure. Source-auth/admission tests remain native owner suites.
 * Authored UNRUN for GitHub Actions; no provider, database or model semantics are used here. */
import {describe,expect,it} from 'vitest';
import {resolvePrivatePerformanceGuideIntent,privatePerformanceGuideContext} from '../packs/performance/onehr/guide-service';
import type {PerformanceGuideFact} from '../packs/performance/onehr/guide-model';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import vi from '../messages/vi.json';import ta from '../messages/ta.json';import th from '../messages/th.json';
const fact=(id:string):PerformanceGuideFact=>({id,label:'LOCAL canonical '+id,text:'LOCAL authorized source '+id,href:'/performance/workspace',source:id.startsWith('guide:')?'Performance guide':id.startsWith('task:')||id==='dashboard'?'Your dashboard':'Your record'});
const facts=['dashboard','summary:own','task:assigned','calendar:own','current:own','history:released','record:own','guide:after-submit'].map(fact);
describe('private Performance guide local intent',()=>{
 it.each(Object.entries({en,ms,zh,vi,ta,th}))('accepts actual %s source-owned own-task shortcuts',(_locale,messages)=>{
  for(const [key,intent]of [['todo','status'],['dates','calendar'],['result','history'],['after','guide']]as const)expect(resolvePrivatePerformanceGuideIntent(messages.onehr.ask[key])).toBe(intent);
 });
 it.each(['Do not show my current status','Alice review status','When does Alice review close?','Show my status and Alice result','My review but not my status','My current result and my previous result','Why did Alice get a rating?','Show records for employee 123','My review PRIVATE_QUESTION','March 2026','Tell me something about status','=UNANSWERED_QUESTION'])('does not infer own subject/scope/polarity from a keyword hit: %s',question=>{
  expect(resolvePrivatePerformanceGuideIntent(question)).toBeNull();
 });
 it('keeps genuine own-status/current/history/calendar requests distinct without sending wording to a model',()=>{
  expect(resolvePrivatePerformanceGuideIntent('What are my current tasks?')).toBe('status');expect(resolvePrivatePerformanceGuideIntent('My review')).toBe('status');
  expect(resolvePrivatePerformanceGuideIntent('When is my review due?')).toBe('calendar');expect(resolvePrivatePerformanceGuideIntent('What is my current result?')).toBe('current');expect(resolvePrivatePerformanceGuideIntent('Show my previous review')).toBe('history');
 });
});
describe('private Performance guide eligible source closure',()=>{
 it('does not substitute current ratings/history for a task-status question',()=>expect(privatePerformanceGuideContext('My review',facts,'status').map(f=>f.id)).toEqual(['dashboard','summary:own','task:assigned']));
 it('uses only native calendar references for own deadlines',()=>expect(privatePerformanceGuideContext('When is my review due?',facts,'calendar').map(f=>f.id)).toEqual(['calendar:own']));
 it('never substitutes the current result for missing released history, or tasks for a missing result',()=>{
  expect(privatePerformanceGuideContext('Show my previous review',facts.filter(f=>!f.id.startsWith('history:')),'history')).toEqual([]);
  expect(privatePerformanceGuideContext('My current result',facts,'current').map(f=>f.id)).toEqual(['current:own']);
  expect(privatePerformanceGuideContext('My current result',facts.filter(f=>!f.id.startsWith('current:')),'current')).toEqual([]);
 });
 it('restores only the requested authorized record/reference category, retaining exact local identity and text',()=>{
  const source=privatePerformanceGuideContext('My performance record',facts,'record');expect(source.map(f=>f.id).sort()).toEqual(['current:own','history:released','record:own']);for(const item of source)expect(item).toBe(facts.find(f=>f.id===item.id));
  expect(privatePerformanceGuideContext('What happens after I submit?',facts,'guide').map(f=>f.id)).toEqual(['guide:after-submit']);
 });
 it('applies kind filtering before the 120-reference bound so unrelated records cannot crowd out an own calendar',()=>{
  const source=[...Array.from({length:1000},(_,i)=>fact(`record:${i}`)),fact('calendar:own')];expect(privatePerformanceGuideContext('My review dates',source,'calendar').map(f=>f.id)).toEqual(['calendar:own']);
 });
});
