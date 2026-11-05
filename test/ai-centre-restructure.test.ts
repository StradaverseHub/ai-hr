/** AI Centre restructure (owner decisions 26–29, 4 November 2026): each fact lives in one place, and everything else is a
 * link or a count. Source and data pins that fail quietly otherwise; the rendered screens are in
 * test/ai-centre-restructure.dom.test.tsx, the forward stubs in test/ai-centre-operations-guards.test.ts. No database. */
import fs from 'node:fs';
import path from 'node:path';
import {describe,expect,it} from 'vitest';
import {DIGEST_PAGES} from '../core/digest/daily-digest';

const ROOT=path.resolve(__dirname,'..');
const read=(rel:string)=>fs.readFileSync(path.join(ROOT,rel),'utf8');
const code=(rel:string)=>read(rel).replace(/\/\*[\s\S]*?\*\//g,'').replace(/(^|[^:'"`])\/\/.*$/gm,'$1');
const walk=(dir:string):string[]=>fs.readdirSync(path.join(ROOT,dir),{withFileTypes:true}).flatMap(entry=>{
 const rel=path.join(dir,entry.name);return entry.isDirectory()?walk(rel):/\.(tsx?|mjs)$/.test(entry.name)?[rel]:[];});

describe('one place per fact',()=>{
 it('Today fix c: the setup finding opens the go-live setup with its stages, not Record readiness',()=>{
  expect(DIGEST_PAGES.setup).toBe('/payroll/setup?readiness=full');
  expect(fs.existsSync(path.join(ROOT,'app/payroll/setup/page.tsx'))).toBe(true);
 });

 it('Today fix b: passports are shown once, as the loop card; Today reads no second 30-day list',()=>{
  expect(code('components/today/reads.ts')).not.toMatch(/followupItemsTx|passport_expiry/);
  expect(code('components/today/sections.tsx')).not.toMatch(/passport/i);
 });

 it('Today fix d: Today counts exceptions with the same read and arguments as Exceptions',()=>{
  expect(code('components/today/reads.ts')).toContain('openExceptionsAcrossRuns(s)');
  expect(code('app/control-tower/exceptions/page.tsx')).toContain('openExceptionsAcrossRuns(s)');
 });

 it('decision 28: an exception is resolved on Exceptions only; the Salary payroll and run pages link there',()=>{
  const forms=walk('app').filter(file=>/action=\{resolveAnomalyAction\}|action=\{resolveAcknowledgedBlockAction\}|action=\{approveAgentActionAction\}/.test(code(file)));
  expect(forms).toEqual([path.join('app','control-tower','exceptions','page.tsx')]);
  expect(code('app/control-tower/loops/payroll-cycle/salary/page.tsx')).toContain('/control-tower/exceptions#acknowledged-blocks');
  expect(code('app/payroll/[batchId]/anomalies/page.tsx')).toContain('href="/control-tower/exceptions"');
 });

 it('decision 29: threshold proposals are decided in payroll-cycle Settings only; AI quality links there',()=>{
  const deciders=[...walk('app'),...walk('components')].filter(file=>/action=\{(decideThresholdProposalAction|decideProposalAction|revertProposalAction)\}/.test(code(file)));
  expect(deciders).toEqual([path.join('app','control-tower','loops','payroll-cycle','settings','page.tsx')]);
  expect(code('components/ai-centre/ai-quality.tsx')).toContain("const SETTINGS_HREF = '/control-tower/loops/payroll-cycle/settings';");
 });

 it('decision 26: no staffing ratio is computed or rendered anywhere in the product source',()=>{
  const files=[...walk('app'),...walk('components'),...walk('core'),...walk('lib')];
  expect(files.length).toBeGreaterThan(500);
  for(const file of files)expect(code(file),file).not.toMatch(/\bimpliedOperators\b|EXCEPTIONS_PER_OPERATOR_PER_CYCLE|ratioTitle|ratioAssumption|impliedOperators'/);
  // HR capacity shows hours from the stored baseline, never a full-time equivalent.
  expect(code('components/ai-centre/capacity-processes.tsx')).toContain('estimateLoad(p.staffActionsPer30, minutes, null)');
  expect(code('components/ai-centre/capacity-processes.tsx')).not.toMatch(/fteHours|estimateFte/);
 });

 it('the work queue is part of Record readiness, and every Refresh returns there',()=>{
  expect(code('app/control-tower/orchestrator-actions.ts')).toContain("const target = '/control-tower/readiness?';");
  expect(code('app/control-tower/readiness/page.tsx')).toContain('OrchestrationWorkQueue({ view: queue, refresh: sp.refresh, canViewRuns: isGroupAdmin(s), rows: false })');
  expect(code('app/control-tower/readiness/page.tsx')).toContain('readinessLoopAsks(s, people)');
 });
});
