/** Real Node controller-model suites only; never TypeScript or runtime acceptance. */
import {execFileSync} from 'node:child_process';
import {expect,it} from 'vitest';
const selectors=[
 '.github/ci/diagnostics/compiler-boundary.test.mjs',
 '.github/ci/diagnostics/compiler-consumer-trace.test.mjs',
 '.github/ci/diagnostics/compiler-attribution.test.mjs',
 '.github/ci/diagnostics/compiler-incremental.test.mjs',
];
it.for(selectors)('executes all native controller assertions in %s without skips',{timeout:35000},file=>{
 const output=execFileSync(process.execPath,['--test','--test-reporter=tap',file],
  {encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024,stdio:['ignore','pipe','pipe']});
 const count=(name:string)=>{
  const rows=[...output.matchAll(new RegExp('^# '+name+' ([0-9]+)$','gm'))];
  expect(rows,`One actual native TAP ${name} summary`).toHaveLength(1);return Number(rows[0][1]);
 };
 const total=count('tests'),passed=count('pass');
 expect(total).toBeGreaterThan(0);expect(passed).toBe(total);
 for(const name of ['fail','cancelled','skipped','todo'])expect(count(name),name).toBe(0);
 expect(output).not.toMatch(/^Bail out!/m);
 // Keep the actual nested assertion identities and counts in hosted logs; a
 // green wrapper alone is not the underlying coverage claim.
 process.stdout.write(output);
});
