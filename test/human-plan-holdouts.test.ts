/** Fixed supplemental quality/security inputs, not a live model capability claim. */
import {describe,expect,it} from 'vitest';
import {HUMAN_PLAN_HOLDOUTS,humanQuestionPrompt} from '../lib/ai/human-plan-holdouts';
import {adjudicatePromptReadPlan} from '../lib/ai/module-agent-prompt-candidate';
describe('independent multilingual human-question contract',()=>{
 it('has independent positive and prohibited-target expectations for every supported locale',()=>{expect(HUMAN_PLAN_HOLDOUTS).toHaveLength(12);expect(new Set(HUMAN_PLAN_HOLDOUTS.map(row=>row.id)).size).toBe(12);for(const locale of ['en','ms','zh','ta','th','vi']){const rows=HUMAN_PLAN_HOLDOUTS.filter(row=>row.locale===locale);expect(rows.map(row=>row.decision)).toEqual(['read','refuse']);expect(JSON.parse(humanQuestionPrompt(rows[0].question,locale))).toEqual({locale,question:rows[0].question});for(const row of rows)expect(adjudicatePromptReadPlan(JSON.stringify({decision:row.decision,modules:row.modules}))).toEqual({decision:row.decision,modules:row.modules});}});
 it('does not admit caller scopes, five modules, facts, effects, duplicated modules or raw model prose',()=>{for(const text of ['PRIVATE invented salary',JSON.stringify({decision:'read',modules:['employees'],facts:{salary:99}}),JSON.stringify({decision:'read',modules:['employees','employees']}),JSON.stringify({decision:'read',modules:['employees','org','payroll','leave','attendance']})])expect(()=>adjudicatePromptReadPlan(text)).toThrow();});
});
