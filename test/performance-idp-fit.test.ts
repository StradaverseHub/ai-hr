import {expect,it} from 'vitest';
import golden from './fixtures/onehr/idp-fit-golden.json';
import {plainIdpFit,adjudicateIdpFit,type IdpFitFacts} from '../packs/performance/onehr/idp-fit-model';
it('matches 192 isolated source cases including missing actions, direction, specific gap coverage and weak results',()=>{
 expect(golden).toHaveLength(192);for(const example of golden)expect(plainIdpFit('Nadia',example.facts as IdpFitFacts,example.mine),example.name).toEqual(example.expected);
});
it('rejects the whole optimistic model response and invented facts, figures and rating advice',()=>{
 const facts=golden[0].facts as IdpFitFacts,text='Nadia has no goals yet. Their plan has no actions.',base={paragraph:'Their plan has no goals yet.',verdict:'not_yet',verdict_why:'Their plan has no actions.',discuss:[]};
 expect(adjudicateIdpFit('Nadia',facts,text,'Nadia',JSON.stringify(base))).toMatchObject({verdict:'not_yet'});
 for(const patch of [{verdict:'fits'},{verdict:'partly_fits'},{paragraph:'Nadia completed 999 projects.'},{paragraph:'Nadia should receive a higher rating.'},{paragraph:'Nadia is Outstanding.'},{paragraph:'Nadia should attend the Zephyr programme.'}])expect(adjudicateIdpFit('Nadia',facts,text,'Nadia',JSON.stringify({...base,...patch}))).toBeNull();
 expect(adjudicateIdpFit('Nadia',facts,text,'Nadia','Their plan has no goals.')).toBeNull();
});
it('does not present a missing KPI result as a fit and does not mistake current-role wording for a future step',()=>{
 const f:IdpFitFacts={goals:[{area:'Service',text:'Service recovery work'}],no_action:[],direction:'Improve supplier lead time',step_text:'',developing:[],weak_kpis:[],pm_self:'BE',pm_mod:'BE',tm_self:null,tm_mod:null,self_ahead:false,has_kpis:true,pm_lines:[]};
 expect(plainIdpFit('Nadia',f)).toMatchObject({verdict:'partly_fits',verdict_why:"Their KPI results aren't in for this reading yet."});
 expect(plainIdpFit('Nadia',{...f,pm_lines:[{kpi:'Delivery',self:'BE',mod:'BE'}]}).verdict).toBe('fits');
});

it('keeps plan context in user-facing mobility words and excludes manager comments',async()=>{
 const {idpFitContext,idpFitSourceSchema}=await import('../packs/performance/onehr/idp-fit-context');
 const value=idpFitSourceSchema.parse({name:'Nadia',status:'shared',mine:true,companyId:'00000000-0000-4000-8000-000000000001',goals:[{id:'00000000-0000-4000-8000-000000000002',area:'Service recovery',dueOn:'',onJob:'Practise service recovery',fromOthers:'',formalLearning:'',status:'not_started',managerComment:'PRIVATE_GOAL_COMMENT'}],career:{aspiration:'Grow service skills',mobility:'company_in_group',mobilityNote:'',targetProfileId:null},bands:{aBands:[1,1.51,2.51,3.51,4.51],bBands:[],lowMaxPct:40,midMaxPct:75},hasFramework:true,hasKpis:false,kpis:[],editableKpiIds:[],competencyStatus:'pending',competencies:[],competencyRemark:'',drafts:[]});
 const result=idpFitContext(value);expect(result.text).toContain('Open to another company in my BG');expect(result.text).not.toContain('company_in_group');expect(result.text).not.toContain('PRIVATE_GOAL_COMMENT');
});

it('matches source BG wording without telling that reviewer to act as the line manager',async()=>{
 const {talentIdpFit}=await import('../packs/performance/onehr/idp-fit-model');const {default:cases}=await import('./fixtures/onehr/talent-idp-steps-golden.json');
 const base=plainIdpFit('Nadia',golden[0].facts as IdpFitFacts);expect(cases).toHaveLength(4);
 for(const example of cases){const result=talentIdpFit({...base,discuss:example.steps,scores:'KPIs: your moderation; Competency: your review',verdict_why:'Ahead of your moderation.'});expect(result.discuss).toEqual(example.expected);expect(result.scores).toBe("KPIs: their line manager's moderation; Competency: their line manager's review");expect(result.verdict_why).toBe("Ahead of their line manager's moderation.");expect(result.verdict).toBe(base.verdict);}
});
