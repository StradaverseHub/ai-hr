import {expect,it} from 'vitest';
import {competencySectionsFor,readCompetencySections} from '../packs/performance/onehr/competency-section-model';
import {assessmentDraftSchema} from '../packs/performance/onehr/journey-model';
import {potentialInsightFacts,potentialInsightSourceSchema} from '../packs/performance/onehr/potential-insight-model';
it('maps category fields without confusing punctuation and rejects an unassigned category',()=>{
 const f=new FormData();f.append('sectionName','Technical. Service');f.append('sectionRemark.0','  Work examples.  ');f.append('sectionName','Leadership');f.append('sectionRemark.1','');
 const sections=readCompetencySections(f);expect(competencySectionsFor(sections,[{principle:'Technical. Service'},{principle:'Leadership'}])).toEqual({'Technical. Service':'Work examples.',Leadership:''});expect(()=>competencySectionsFor(sections,[{principle:'Leadership'}])).toThrow(/assigned/);
});
it('keeps category drafts in the same author-owned competency payload without losing existing answers',()=>{
 for(const kind of ['competency_self','competency_manager'] as const){const d=assessmentDraftSchema.parse({kind,answers:{delivery:{answer:'yes',remark:'An example.'}},remark:'Overall.',sections:{Service:'Category notes.'}});expect(d).toMatchObject({sections:{Service:'Category notes.'},answers:{delivery:{answer:'yes'}}});}
});
it('adds category review remarks to potential evidence only after the manager completes the review',()=>{
 const s=potentialInsightSourceSchema.parse({name:'Nadia',valid:true,raters:4,minimum:4,principles:[],remarks:[],competencyStatus:'reviewed',competencyRemark:'',managerRemark:'',managerSections:{Service:'Practise handling escalations.'},competencies:[{text:'Delivery',principle:'Service',future:false,self:'yes',manager:'yes',managerRemark:''}]});
 expect(potentialInsightFacts(s).source).toContain("their line manager's note on Service: <<<Practise handling escalations.>>>");s.competencyStatus='submitted';expect(potentialInsightFacts(s).source).not.toContain('Practise handling');
});
