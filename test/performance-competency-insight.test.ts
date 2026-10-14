import {expect,it} from 'vitest';
import golden from './fixtures/onehr/competency-insight-golden.json';
import {adjudicateCompetencyInsight,competencyInsightFacts,plainCompetencyInsight,type CompetencyClaim} from '../packs/performance/onehr/competency-insight-model';
it('matches the isolated source assessment and rationale across current/next answers, evidence and contradictions',()=>{
 expect(golden).toHaveLength(48);
 for(const example of golden){const facts=competencyInsightFacts(example.rows as CompetencyClaim[],example.remark),{source,...values}=facts;
  expect(values,example.name).toEqual(example.facts);expect(plainCompetencyInsight('Nadia',facts),example.name).toEqual(example.expected);
 }
});
it('keeps the deterministic evidence floor and refuses invented claims and rating advice',()=>{
 const facts=competencyInsightFacts([{text:'Planning',principle:'Technical',future:false,self:'yes',selfRemark:''}],'');
 const good={paragraph:'Their Planning answer is Demonstrate, with no reason given.',verdict:'well_justified',verdict_why:'Their claim has no reason.',discuss:[]};
 expect(adjudicateCompetencyInsight('Nadia',facts,JSON.stringify(good))).toMatchObject({verdict:'not_justified'});
 for(const paragraph of ['Nadia deserves a promotion.','Nadia completed 999 projects.','Nadia delivered the Zephyr programme.'])expect(adjudicateCompetencyInsight('Nadia',facts,JSON.stringify({...good,paragraph}))).toBeNull();
});
it('counts a next-only competency once and keeps missing competencies without a verdict',()=>{
 const facts=competencyInsightFacts([{text:'Planning',principle:'Technical',future:true,self:'yes',selfRemark:'I verified the agreed plan weekly.'}],'');
 expect(facts).toMatchObject({total:1,demo:['Planning'],both:[],next_dev:[],next_only:[]});
 expect(plainCompetencyInsight('Nadia',competencyInsightFacts([],''))).toMatchObject({verdict:null,discuss:[]});
});
