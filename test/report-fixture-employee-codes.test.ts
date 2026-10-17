import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
import {requireEmployeeCode} from '../lib/employee-code';
import {REPORT_FIXTURE_ACTOR_KEYS,reportFixtureActorCode,preflightReportFixtureEmployeeCodes} from '../scripts/report-fixture-employee-codes.mjs';
describe('Reports fixture planned employee identifiers',()=>{
 it('preserves actor keys but uses employee IDs accepted by the real hire validator',()=>{
  expect(()=>requireEmployeeCode('R18-HR_A')).toThrow();
  expect(reportFixtureActorCode('HR_A')).toBe('R18-HR-A');expect(reportFixtureActorCode('HR_B')).toBe('R18-HR-B');
  const plan=preflightReportFixtureEmployeeCodes();expect(Object.keys(plan.actors)).toEqual(REPORT_FIXTURE_ACTOR_KEYS);
  const codes=[...Object.values(plan.actors),...plan.subjects];expect(codes).toHaveLength(62);expect(new Set(codes).size).toBe(62);
  for(const code of codes)expect(requireEmployeeCode(code)).toBe(code);
  expect(()=>reportFixtureActorCode('unknown_actor')).toThrow();
 });
 it('preflights before DB owner imports and uses the same actor formatter in preparation and identity readback',()=>{
  const source=readFileSync(new URL('../scripts/dev-fixture-employee-master.mts',import.meta.url),'utf8');
  const preflight=source.indexOf('const plannedEmployeeCodes=preflightReportFixtureEmployeeCodes()'),imports=source.indexOf("await import('../db/client')");
  expect(preflight).toBeGreaterThanOrEqual(0);expect(imports).toBeGreaterThan(preflight);
  expect(source).toContain('const employeeCode=reportFixtureActorCode(key)');expect(source).toContain('employeeCode=plannedEmployeeCodes.subjects[i-1]');
  const coordinator=readFileSync(new URL('../scripts/original18-browser-target.mjs',import.meta.url),'utf8');expect(coordinator).toContain('row.employeeCode!==reportFixtureActorCode(key)');
 });
});
