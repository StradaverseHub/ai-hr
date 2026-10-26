/** Authored UNRUN. Coverage/immutability checks are not translation, model quality or security PASS. */
import {describe,expect,it} from 'vitest';
import {MODULE_AGENT_CAPABILITIES} from '../lib/ai/module-agents';
import {PROMPT_MODULE_QUESTIONS,PROMPT_SECURITY_QUESTIONS,type PromptHoldoutLocale} from '../lib/ai/module-agent-prompt-holdouts';
// Deliberately independent expected inventory. A catalogue change must cause an explicit holdout review,
// rather than silently generating new expectations from the implementation under evaluation.
const EXPECTED_MODULES=['employees','org','leave','ess','approvals','knowledge_base','payroll','attendance','claims','performance','rewards','lifecycle','toil','multi_cycle_payroll','typed_pay_components','country-my','notifications','system_explorer','assistant','system_testing'] as const;
const EXPECTED_LOCALES=['en','ms','zh','ta','th','vi'] as const;
const EXPECTED_SECURITY=['write','peer','company','payMath'] as const;
const sameKeys=(value:object,keys:readonly string[])=>expect(Object.keys(value).sort()).toEqual([...keys].sort());
describe('independent fixed multilingual prompt-plan holdouts',()=>{
 it('pins exactly twenty canonical module capabilities and six complete locale maps',()=>{
  expect(EXPECTED_MODULES).toHaveLength(20);expect(new Set(EXPECTED_MODULES).size).toBe(20);expect(MODULE_AGENT_CAPABILITIES.map(([module])=>module).sort()).toEqual([...EXPECTED_MODULES].sort());sameKeys(PROMPT_MODULE_QUESTIONS,EXPECTED_LOCALES);sameKeys(PROMPT_SECURITY_QUESTIONS,EXPECTED_LOCALES);
 });
 it.each(EXPECTED_LOCALES)('%s supplies twenty distinct fixed module jobs and all four distinct refusal questions',locale=>{
  const modules=PROMPT_MODULE_QUESTIONS[locale],security=PROMPT_SECURITY_QUESTIONS[locale];sameKeys(modules,EXPECTED_MODULES);sameKeys(security,EXPECTED_SECURITY);
  const questions=[...Object.values(modules),...Object.values(security)];expect(questions).toHaveLength(24);expect(new Set(questions.map(text=>text.normalize('NFKC').trim())).size).toBe(24);
  for(const question of questions){expect(typeof question).toBe('string');expect(question).toBe(question.trim());expect(question.length).toBeGreaterThan(10);expect(question.length).toBeLessThan(800);expect(question).not.toMatch(/\{\{|\$\{|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);}
  if(locale!=='en')for(const module of EXPECTED_MODULES)expect(modules[module]).not.toBe(PROMPT_MODULE_QUESTIONS.en[module]);
 });
 it('has exactly144 independent fixed questions, without duplicate case text across locales',()=>{
  const questions=EXPECTED_LOCALES.flatMap(locale=>[...Object.values(PROMPT_MODULE_QUESTIONS[locale]),...Object.values(PROMPT_SECURITY_QUESTIONS[locale])]);expect(questions).toHaveLength(144);expect(new Set(questions.map(text=>text.normalize('NFKC').trim())).size).toBe(144);
 });
 it('retains each non-Latin locale’s script rather than reusing English module identifiers as questions',()=>{
  const scripts:Partial<Record<PromptHoldoutLocale,RegExp>>={zh:/[\u3400-\u9fff]/,ta:/[\u0b80-\u0bff]/,th:/[\u0e00-\u0e7f]/,vi:/[à-ỹ]/i};
  for(const locale of ['zh','ta','th','vi'] as const)for(const question of [...Object.values(PROMPT_MODULE_QUESTIONS[locale]),...Object.values(PROMPT_SECURITY_QUESTIONS[locale])])expect(question).toMatch(scripts[locale]!);
 });
 it('pins distinct canonical jobs and explicit existing-admin read-only scope without claiming write authority',()=>{
  const q=PROMPT_MODULE_QUESTIONS.en;expect(q.approvals).toContain('decisions');expect(q.approvals).toContain('own submitted leave');expect(q.leave).toContain('balance');expect(q.knowledge_base).toContain('published documents');expect(q.knowledge_base).toContain('index');expect(q.ess).toContain('self-service');expect(q['country-my']).toContain('Malaysian statutory');expect(q.typed_pay_components).toContain('stored pay components from released payroll');expect(q.multi_cycle_payroll).toContain('released payroll runs across pay cycles');
  for(const module of ['system_explorer','system_testing'] as const){expect(q[module]).toContain('existing administrator rights');expect(q[module]).toContain('do not');expect(q[module]).toContain('grant rights');}expect(q.system_explorer).toContain('schema catalog');expect(q.system_testing).toContain('recorded statuses of existing test cases');expect(q.system_testing).toContain('do not run tests');
  const refusal=PROMPT_SECURITY_QUESTIONS.en;expect(refusal.write).toContain('skip the human');expect(refusal.peer).toContain('another employee');expect(refusal.company).toContain('another company');expect(refusal.company).toContain('bank account');expect(refusal.payMath).toContain('Invent');expect(refusal.payMath).toContain('calculate');
 });
 it('deeply freezes the exported data graph, including every locale map',()=>{
  expect(Object.isFrozen(PROMPT_MODULE_QUESTIONS)).toBe(true);expect(Object.isFrozen(PROMPT_SECURITY_QUESTIONS)).toBe(true);
  for(const locale of EXPECTED_LOCALES){const row=PROMPT_MODULE_QUESTIONS[locale],security=PROMPT_SECURITY_QUESTIONS[locale];expect(Object.isFrozen(row)).toBe(true);expect(Object.isFrozen(security)).toBe(true);expect(Reflect.set(row,'leave','mutated')).toBe(false);expect(Reflect.set(security,'write','mutated')).toBe(false);expect(Reflect.deleteProperty(row,'leave')).toBe(false);}
 });
});
