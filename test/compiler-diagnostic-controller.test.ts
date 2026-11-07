/** Real Node controller-model suites only; never TypeScript or runtime acceptance. */
import {spawnSync} from 'node:child_process';
import {expect,it} from 'vitest';
const selectors=[
 '.github/ci/diagnostics/compiler-boundary.test.mjs',
 '.github/ci/diagnostics/compiler-consumer-trace.test.mjs',
 '.github/ci/diagnostics/compiler-attribution.test.mjs',
 '.github/ci/diagnostics/compiler-incremental.test.mjs',
];
it.for(selectors)('executes all native controller assertions in %s without skips',{timeout:35000},file=>{
 const result=spawnSync(process.execPath,['--test','--test-reporter=tap',file],
  {encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024,stdio:['ignore','pipe','pipe']});
 // Emit actual nested outcomes even when a child fails, before preserving the
 // mandatory zero exit, no signal/error and complete no-skip TAP checks.
 process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');
 expect(result.error,'Native controller child spawn/timeout/output bound').toBeUndefined();
 expect(result.signal,'Native controller child signal').toBeNull();
 expect(result.status,'Native controller child exit').toBe(0);
 const output=result.stdout;
 const count=(name:string)=>{
  const rows=[...output.matchAll(new RegExp('^# '+name+' ([0-9]+)$','gm'))];
  expect(rows,`One actual native TAP ${name} summary`).toHaveLength(1);return Number(rows[0][1]);
 };
 const total=count('tests'),passed=count('pass');
 expect(total).toBeGreaterThan(0);expect(passed).toBe(total);
 for(const name of ['fail','cancelled','skipped','todo'])expect(count(name),name).toBe(0);
 expect(output).not.toMatch(/^Bail out!/m);
});
