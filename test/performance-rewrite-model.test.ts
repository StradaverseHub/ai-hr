import { describe,expect,it } from 'vitest';
import { adjudicateAssessmentRewrite } from '../packs/performance/onehr/rewrite-model';
import golden from './fixtures/onehr/rewrite-golden.json';
describe('source rewrite grounding rules',()=>{
 it('matches the isolated source validator over factual polishing, figures and invented clauses',()=>{
  expect(golden.cases.length).toBeGreaterThan(10);
  for(const row of golden.cases)expect(adjudicateAssessmentRewrite(row.draft,row.instruction,row.context,row.text).ok,row.name).toBe(row.ok);
 });
 it('allows forward-looking development actions while keeping output bounded',()=>{
  expect(adjudicateAssessmentRewrite('','','Facilitation','Lead a practical retrospective and ask a mentor for feedback.',{forwardLooking:true}).ok).toBe(true);
  expect(adjudicateAssessmentRewrite('','','','',{forwardLooking:true}).ok).toBe(false);
  expect(adjudicateAssessmentRewrite('','','','x'.repeat(4001),{forwardLooking:true}).ok).toBe(false);
 });
 it('refuses invented figures in every script and unsupported non-ASCII clauses',()=>{
  expect(adjudicateAssessmentRewrite('我完成了任务。','润色。','','我完成了任务。').ok).toBe(true);
  expect(adjudicateAssessmentRewrite('我完成了任务。','润色。','','我完成了42个任务。')).toMatchObject({ok:false,reason:'figures'});
  expect(adjudicateAssessmentRewrite('Saya membantu pasukan.','Ringkaskan.','','Saya membantu sepuluh pelanggan baharu dengan peningkatan kepuasan luar biasa.').ok).toBe(false);
  expect(adjudicateAssessmentRewrite('我完成了任务。','润色。','','成功创造全球卓越营销战略，实现国际物流重大突破，达成客户留存创新增长。').ok).toBe(false);
 });
});
