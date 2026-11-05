/** AI Centre restructure, owner decision 28: payroll exceptions are resolved on Operations › Exceptions only.
 *
 * A source-level guard beside the rendered Salary payroll page (test/payroll-cycle-page.dom.test.tsx, which links to
 * Exceptions and posts no verdict) and the service (test/payroll-loops-hardening.test.ts B5, where a group's "expected"
 * leaves every verdict open): the server actions that resolve an anomaly verdict are posted from the Exceptions page alone,
 * and the anomaly owner's resolve is called only by those actions' services, never by the Salary payroll loop's group
 * disposition. Reads source only; no database. */
import {readFileSync,readdirSync} from 'node:fs';
import {join,relative} from 'node:path';
import {describe,expect,it} from 'vitest';

const root=process.cwd();
const sources=(dir:string):string[]=>readdirSync(join(root,dir),{withFileTypes:true}).flatMap(entry=>{
 const path=join(dir,entry.name);
 if(entry.isDirectory())return sources(path);
 return /\.(ts|tsx)$/.test(entry.name)?[path]:[];
});
const read=(path:string)=>readFileSync(join(root,path),'utf8');
const mentions=(source:string,name:string)=>new RegExp(`\\b${name}\\b`).test(source);

/** Each server action that resolves an anomaly verdict, with the module that defines it. */
const RESOLVING_ACTIONS={
 resolveAnomalyAction:'app/payroll/actions.ts',
 resolveAcknowledgedBlockAction:'app/control-tower/loops/payroll-cycle/actions.ts',
 // Approves the "cause already fixed" closes (core/agent-actions.ts), which resolve verdicts as fixed upstream.
 approveAgentActionAction:'app/control-tower/actions/actions.ts',
} as const;

describe('owner decision 28: exceptions are resolved on Exceptions only',()=>{
 it('posts every verdict-resolving server action from the Exceptions page alone',()=>{
  const files=[...sources('app'),...sources('components')].map(path=>relative(root,join(root,path)));
  expect(files.length).toBeGreaterThan(200);
  const exceptions='app/control-tower/exceptions/page.tsx';
  for(const [action,home] of Object.entries(RESOLVING_ACTIONS)){
   expect(read(home),`${action} is defined in ${home}`).toContain(`export async function ${action}(`);
   const users=files.filter(path=>path!==home&&mentions(read(path),action));
   expect(users,action).toEqual([exceptions]);
  }
  // Non-vacuity: the Exceptions page renders a form for each.
  const page=read(exceptions);
  for(const action of Object.keys(RESOLVING_ACTIONS))expect(page,action).toContain(`action={${action}}`);
 });

 it('keeps the Salary payroll page free of any resolver, and the group disposition calls none',()=>{
  const salary=read('app/control-tower/loops/payroll-cycle/salary/page.tsx');
  for(const action of Object.keys(RESOLVING_ACTIONS))expect(mentions(salary,action),action).toBe(false);
  expect(salary).toContain('href="/control-tower/exceptions"');
  // The anomaly owner's resolve is named only by its owner, the run action module, the two services the Exceptions page
  // posts to and that page's own note.
  const callers=[...sources('core'),...sources('lib'),...sources('app'),...sources('components')]
   .filter(path=>path!=='core/payroll-anomaly.ts'&&mentions(read(path),'resolveAnomalyVerdict')).sort();
  expect(callers).toEqual(['app/control-tower/exceptions/page.tsx','app/payroll/actions.ts','core/agent-actions.ts','core/loops/grouped-dispositions.ts']);
  const grouped=read('core/loops/grouped-dispositions.ts');
  const dispose=grouped.slice(grouped.indexOf('export async function disposeSwingGroup'),grouped.indexOf('export type AcknowledgedBlock'));
  expect(dispose.length).toBeGreaterThan(500);
  expect(dispose).toContain('recordSwingDisposition(');
  expect(dispose).not.toMatch(/resolveAnomalyVerdict|payroll_anomaly_verdict|payrollAnomalyVerdict/);
  // Its one resolve is the acknowledged block's, which Exceptions posts.
  expect(grouped.match(/resolveAnomalyVerdict\(/g)).toHaveLength(1);
  expect(grouped.slice(grouped.indexOf('export async function resolveAcknowledgedBlock'))).toContain('resolveAnomalyVerdict(');
 });
});
