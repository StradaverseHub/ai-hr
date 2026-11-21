/** The longer provider budget is an explicit background option, never a raised request-path cap. */
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {describe,expect,it} from 'vitest';
import {BACKGROUND_DRAFT_TIMEOUT_CAP_MS,REQUEST_DRAFT_TIMEOUT_CAP_MS} from '../lib/ai';
const walk=(dir:string):string[]=>readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?walk(join(dir,entry.name)):/\.tsx?$/.test(entry.name)?[join(dir,entry.name)]:[]);
describe('background draft budget',()=>{
 it('keeps the 22 s request-path cap and bounds the background budget below the gateway ceiling',()=>{
  expect(REQUEST_DRAFT_TIMEOUT_CAP_MS).toBe(22_000);
  const budget=Number(/PAY_FORMULA_BACKGROUND_TIMEOUT_MS=(\d+)_?(\d*)/.exec(readFileSync('core/pay-formula-ai.ts','utf8'))!.slice(1).join(''));
  expect(budget).toBe(90_000);expect(budget).toBeGreaterThan(REQUEST_DRAFT_TIMEOUT_CAP_MS);expect(budget).toBeLessThanOrEqual(BACKGROUND_DRAFT_TIMEOUT_CAP_MS);
 });
 it('lets only the background formula generator pass the background option',()=>{
  const users=['app','core','lib','packs','scripts'].flatMap(walk).filter(file=>/\bbackground\s*:\s*true\b/.test(readFileSync(file,'utf8'))&&/\bgenerateDraft\s*\(/.test(readFileSync(file,'utf8')));
  expect(users.sort()).toEqual(['core/pay-formula-ai.ts']);
  // The background entry point is reached only from the job runner, never from a server action or page.
  const callers=['app','core','lib','packs'].flatMap(walk).filter(file=>/\bdraftPayFormulaInBackground\s*\(/.test(readFileSync(file,'utf8')));
  expect(callers.sort()).toEqual(['core/pay-formula-ai-job.ts','core/pay-formula-ai.ts']);
 });
});
