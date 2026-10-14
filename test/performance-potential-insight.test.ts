import {expect,it} from 'vitest';
import contexts from './fixtures/onehr/potential-source-golden.json';
import golden from './fixtures/onehr/potential-insight-golden.json';
import {plainPotentialInsight,potentialInsightFacts,potentialInsightError,type PotentialInsightSource} from '../packs/performance/onehr/potential-insight-model';
const source=():PotentialInsightSource=>({name:'Nadia',valid:true,raters:4,minimum:4,principles:[{name:'Trust',description:'Build trust',yes:3,total:4,comments:['Communicates clearly.']}],remarks:['Explains decisions clearly.'],competencyStatus:'reviewed',competencyRemark:'I practise planning.',managerRemark:'Practise planning.',competencies:[{text:'Plan work',skillTitle:'Planning',principle:'Technical',future:true,self:'yes',manager:'no',managerRemark:'Needs practical examples.'}]});
it('matches all isolated original-source potential plain summary cases',()=>{expect(golden).toHaveLength(48);for(const c of golden)expect(plainPotentialInsight(c.facts)).toBe(c.expected);});
it('uses exact unweighted agreement and only reviewed manager calls',()=>{
 const s=source();s.principles=[{...s.principles[0],yes:149,total:200},{...s.principles[0],name:'Delivery',yes:2,total:5},{...s.principles[0],name:'Collaboration',yes:39,total:100}];
 const f=potentialInsightFacts(s);expect(f.strong).toEqual([]);expect(f.dev).toEqual(['Collaboration']);expect(f.tc_moved_down).toEqual(['Planning (next level)']);expect(f.source).toContain('Trust (Build trust): raters\' view -- mixed');expect(f.source).toContain('Needs practical examples.');
 s.competencyStatus='submitted';const pending=potentialInsightFacts(s);expect(pending.source).not.toContain('Needs practical');expect(pending.source).not.toContain("manager's competency remark");expect(pending.tc_moved_down).toEqual([]);
});
it('refuses identities, relationship counts, figures and rating advice while accepting grounded themes',()=>{
 const f=potentialInsightFacts(source());for(const text of ['Three peers said they communicate clearly.','A rater said they communicate clearly.','Their score is high.','Their potential band is High.','They deserve promotion.','Agreement is 75%.','Their manager said they communicate clearly.','The matrix rating is high.'])expect(potentialInsightError(f,text)).toBeTruthy();
 expect(potentialInsightError(f,'Their 360 feedback shows strength in Trust. Their reviewed competency is still developing.')).toBeNull();
});
it('sorts anonymous comments and suppresses all evidence below the valid threshold',()=>{
 const s=source();s.principles[0].comments=['zeta','Alpha'];s.remarks=['Second','First'];const f=potentialInsightFacts(s);expect(f.source.indexOf('Alpha')).toBeLessThan(f.source.indexOf('zeta'));expect(f.source.indexOf('First')).toBeLessThan(f.source.indexOf('Second'));
 s.valid=false;expect(potentialInsightFacts(s).source).toBe('');
});

it('matches original anonymous evidence construction across thresholds and reviewed states',()=>{expect(contexts).toHaveLength(144);for(const c of contexts){const facts=potentialInsightFacts(c.input as PotentialInsightSource);expect(facts.source).toBe(c.source);expect(facts).toMatchObject(c.facts);}});
