import {describe,it,expect} from 'vitest';
import {rankKnowledgeArticles,rankPerformanceArticles,assessmentHelpQuery} from '../lib/knowledge-search';
import {loadGuides} from '../lib/guide-catalog';
describe('Performance source FAQ behavior',()=>{
 it('ranks significant words with stable ties and three-article fallback',()=>{
  const rows=[{title:'First',body:'Calibration uses a reference curve.'},{title:'Second',body:'Calibration compares ratings.'},{title:'Third',body:'Development goals.'},{title:'Fourth',body:'KPI results.'}];
  expect(rankKnowledgeArticles('What is calibration reference?',rows).map(r=>r.title)).toEqual(['First','Second']);
  expect(rankKnowledgeArticles('Explain calibration',rows).map(r=>r.title)).toEqual(['First','Second']);
  expect(rankKnowledgeArticles('unknown',rows)).toEqual(rows.slice(0,3));
  expect(assessmentHelpQuery('What is calibration?')).toBe('What is calibration?');
  expect(assessmentHelpQuery('What do I do next?')).toBeNull();expect(assessmentHelpQuery('Move Nadia to High because delivery.')).toBeNull();
 });
 it('publishes all 18 source help topics through the existing native guide catalogue',()=>{
  const guides=loadGuides().filter(g=>g.meta.category==='performance-faq');expect(guides).toHaveLength(18);expect(guides.every(g=>g.meta.audience==='employee')).toBe(true);
  expect(guides.map(g=>g.body).join('\n')).not.toMatch(/OneHR/);
  for(const topic of ['calibration-about','potential-band','career-profile-about','after-submit','confidentiality'])expect(guides.some(g=>g.meta.slug==='performance-faq-'+topic)).toBe(true);
 });
});

it('preserves source search tags and catalogue ordering independently of native insertion order',()=>{
 const rows=[{slug:'performance-faq-good-360-comment',title:'Feedback',body:'Write a useful comment.'},{slug:'performance-faq-kpi-justification',title:'KPI results',body:'Explain your delivery.'},{slug:'performance-faq-star-justification',title:'STAR',body:'Show an example.'}];
 expect(rankPerformanceArticles('unknown',rows).map(r=>r.slug)).toEqual(['performance-faq-kpi-justification','performance-faq-good-360-comment','performance-faq-star-justification']);
 expect(rankPerformanceArticles('behaviour',rows).map(r=>r.slug)).toEqual(['performance-faq-good-360-comment']);
 expect(rankPerformanceArticles('evidence',rows).some(r=>r.slug==='performance-faq-kpi-justification')).toBe(true);
 expect(rankPerformanceArticles('behaviour',rows.slice(1)).some(r=>r.slug==='performance-faq-good-360-comment')).toBe(false);
});
