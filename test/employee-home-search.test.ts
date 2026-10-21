import {describe,expect,it} from 'vitest';
import {homeSearchWords,homeKnowledgeExcerpt,HOME_SEARCH_QUERY_MAX,HOME_SEARCH_DESCRIPTION_MAX} from '../lib/employee-home-search';

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
});
