/** Authored UNRUN. Complete locale copy and exact semantics vocabulary, not independent translation certification. */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe,expect,it} from 'vitest';
import {NATIVE_OUTCOME_ACTIONS} from '../lib/ai/module-native-outcomes';
const locales=['en','ms','zh','ta','vi','th'];
const read=(locale:string)=>JSON.parse(readFileSync(join(process.cwd(),'messages',locale+'.json'),'utf8')).assistant.workspace.nativeOutcomes as Record<string,string>;
describe('native outcome localised human semantics',()=>{
 it('has every action and control in each of the six locales without English fallback',()=>{
  const en=read('en'),keys=Object.keys(en).sort();for(const locale of locales){const copy=read(locale);expect(Object.keys(copy).sort()).toEqual(keys);for(const value of Object.values(copy))expect(value.trim().length).toBeGreaterThan(0);for(const action of Object.keys(NATIVE_OUTCOME_ACTIONS))expect(copy['action_'+action.replace(/[.-]/g,'_')]).toBeTruthy();if(locale!=='en')expect(copy).not.toEqual(en);}
 });
 it('never describes submitted Leave, Claims or payroll close as approval, reimbursement or payment proof',()=>{
  const copy=read('en');expect(copy.action_leave_apply).toContain('not approved');expect(copy.action_claims_submit).toContain('not approved or reimbursed');expect(copy.action_payroll_close).toContain('not paid');expect(copy.action_system_testing_execution_save).toContain('not independent verification');expect(copy.notQuality).toContain('does not prove');expect(copy.candidateIntro).toContain('replace independent evaluation');
 });
});
