import { describe,expect,it } from 'vitest';
import fixture from './fixtures/onehr/insight-golden.json';
import { applyInsightAssessment,plainPerformanceInsight,type InsightFacts } from '../packs/performance/onehr/performance-insight-model';
import type { EvidenceText } from '../packs/performance/onehr/evidence-extraction';
import { adjudicatePerformanceInsight,performanceCaseText } from '../packs/performance/onehr/insight-assessment';
describe('source reviewer insight parity',()=>{
 it('matches source case construction and assessment acceptance, including rejected figures, causes, names, rating advice and false file claims',()=>{
  expect(fixture.assessments.length).toBeGreaterThan(14);expect(fixture.assessments.some(c=>c.accepted)).toBe(true);expect(fixture.assessments.some(c=>!c.accepted)).toBe(true);
  for(const item of fixture.assessments){const facts=item.facts as InsightFacts,texts=new Map(Object.entries(item.texts)) as Map<string,EvidenceText>;
   expect(performanceCaseText(facts,texts),item.name+' case').toBe(item.caseText);
   const checked=adjudicatePerformanceInsight(facts,texts,item.raw,item.caseText,item.extra);expect(checked.ok,item.name).toBe(item.accepted);if(checked.ok)expect(checked.insight,item.name).toEqual(item.expected);
  }
 });
 it('matches independently executed source helpers across target direction, Mechanism B, evidence and locked moderation',()=>{
  expect(fixture.cases.length).toBeGreaterThan(125);
  for(const item of fixture.cases)expect(plainPerformanceInsight(item.facts as InsightFacts,new Map(Object.entries(item.texts)) as Map<string,EvidenceText>),item.name).toEqual(item.expected);
 });
 it('never lets a model raise an unsupported above-target result or remove its mandatory next step',()=>{
  const item=fixture.cases.find(c=>c.name==='A/higher is better/200/none')!,facts=item.facts as InsightFacts,plain=plainPerformanceInsight(facts,new Map());
  const checked=applyInsightAssessment(plain.kpis,facts,new Map(),{kpis:{delivery:{justified:'yes',why:'Fully backed.'}},verdict:'well_justified',verdict_why:'Everything is justified.'});
  expect(checked.verdict).toBe('not_justified');expect(plain.kpis[0].justified).toBe('no');expect(checked.steps[0]).toContain('ask for evidence');
 });
 it('permits a grounded contextual explanation only for an unmoderated on-or-below-target result with no file',()=>{
  const item=fixture.cases.find(c=>c.name==='A/higher is better/100/none')!,facts=item.facts as InsightFacts,plain=plainPerformanceInsight(facts,new Map());
  applyInsightAssessment(plain.kpis,facts,new Map(),{kpis:{delivery:{justified:'yes',why:'The period was explained in the submitted remark.'}}});expect(plain.kpis[0].justified).toBe('yes');
 });
});
