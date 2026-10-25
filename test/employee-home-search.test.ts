import {describe,expect,it} from 'vitest';
import {homeSearchWords,homeKnowledgeExcerpt,homeNavigationSearch,HOME_SEARCH_QUERY_MAX,HOME_SEARCH_DESCRIPTION_MAX} from '../lib/employee-home-search';

describe('bounded model-free Home search words',()=>{
 it('keeps Unicode words and combining marks for all current languages instead of an English-only tokenizer',()=>{
  for(const word of ['leave','cuti','休假','விடுப்பு','วันลา','nghỉ'])expect(homeSearchWords(word)).toEqual([word]);
  expect(homeSearchWords(' Café cafe\u0301  ＣＡＦÉ ')).toEqual(['café']);
 });
 it('deduplicates actual words without inventing a fallback query or treating punctuation as SQL wildcards',()=>{
  expect(homeSearchWords(' Leave LEAVE policy ')).toEqual(['leave','policy']);
  for(const value of ['', '   ', '% _ \\ ; --'])expect(homeSearchWords(value)).toEqual([]);
  expect(homeSearchWords('leave%policy')).toEqual(['leave','policy']);
 });
 it('rejects oversized or non-string inputs without truncating a user query',()=>{
  for(const value of [null,{},['leave'],'x'.repeat(HOME_SEARCH_QUERY_MAX+1),'ﬃ'.repeat(41)])
   expect(()=>homeSearchWords(value)).toThrow(RangeError);
 });
 it('returns a bounded literal authored excerpt rather than inventing a description or splitting a Unicode code point',()=>{
  expect(homeKnowledgeExcerpt(null)).toBeNull();expect(homeKnowledgeExcerpt('   ')).toBeNull();
  expect(homeKnowledgeExcerpt('  Recorded **policy** explanation.  ')).toBe('Recorded **policy** explanation.');
  const excerpt=homeKnowledgeExcerpt('😀'.repeat(HOME_SEARCH_DESCRIPTION_MAX)+'HIDDEN_AFTER_PREVIEW')!;
  expect(excerpt).toBe('😀'.repeat(HOME_SEARCH_DESCRIPTION_MAX)+'…');expect(Array.from(excerpt)).toHaveLength(HOME_SEARCH_DESCRIPTION_MAX+1);
  expect(excerpt).not.toContain('HIDDEN_AFTER_PREVIEW');
 });
 it('matches only supplied permitted navigation rows and keeps links internal, distinct and bounded',()=>{
  const leave={href:'/leave',label:'My Leave',parent:'Leave',section:'My HR'};
  const payroll={href:'/payroll',label:'Payroll',parent:null,section:'Workforce Operations'};
  expect(homeNavigationSearch('leave hr',[leave,payroll])).toEqual([leave]);
  expect(homeNavigationSearch('salary',[leave])).toEqual([]);
  expect(homeNavigationSearch('休假',[{...leave,label:'我的休假'}])).toEqual([{...leave,label:'我的休假'}]);
  expect(homeNavigationSearch('leave',[leave,leave,...['https://evil.invalid','//evil.invalid','/\\evil.invalid','javascript:alert(1)'].map(href=>({...leave,href}))])).toEqual([leave]);
  expect(homeNavigationSearch('leave',Array.from({length:12},(_,i)=>({...leave,href:'/leave/'+i})))).toHaveLength(8);
  expect(homeNavigationSearch('leave',[])).toEqual([]);
 });
});
