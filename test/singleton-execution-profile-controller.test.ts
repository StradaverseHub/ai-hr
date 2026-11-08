/** Actual singleton controller owner, including complete module-JIT source admission.
 * No repository model is imported into this process or replaced with a copy. */
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {expect,it} from 'vitest';
const root=fileURLToPath(new URL('../',import.meta.url));
const expected=[
 "every registered infrastructure file remains exactly once in its native class and a dedicated bounded job",
 "actual full-CI host context, complete plan and closed native prerequisites admit",
 "refuses singleton proof: foreign source",
 "refuses singleton proof: foreign controller",
 "refuses singleton proof: wrong unit",
 "refuses singleton proof: wrong file",
 "refuses singleton proof: wrong profile",
 "refuses singleton proof: claimed focused mode",
 "refuses singleton proof: second attempt",
 "refuses singleton proof: wrong producing run",
 "refuses singleton proof: missing source proof",
 "refuses singleton proof: source byte drift",
 "refuses singleton proof: wrong plan fingerprint",
 "refuses singleton proof: expanded workers",
 "refuses singleton proof: batched file",
 "refuses singleton proof: not systemd",
 "refuses singleton proof: sudo not root",
 "refuses singleton proof: missing nginx",
 "refuses singleton proof: changed nginx bytes",
 "refuses singleton proof: unknown proof key",
 "refuses singleton proof: absent authenticated witness",
 "refuses singleton host: forged focused selection",
 "refuses singleton host: empty focused hint",
 "refuses singleton host: foreign repository",
 "refuses singleton host: other workflow",
 "refuses singleton host: not hosted",
 "refuses singleton host: wrong job",
 "refuses singleton host: rerun",
 "refuses singleton host: dirty candidate",
 "refuses singleton host: dirty controller",
 "refuses singleton host: symlinked source layout",
 "refuses singleton host: foreign evidence path",
 "refuses singleton host: wrong actual source",
 "refuses singleton host: wrong event source",
 "refuses singleton host: foreign event repository",
 "refuses singleton host: unsupported event",
 "cluster receipt is bound to the physical job/run/attempt/unit, not a worker database namespace",
 "database tests bind every actual URL to the canonical owned loopback worker before their bodies run",
 "strict unit verifier requires the complete source-bound singleton invocation and refuses skipped/missing proof",
 "source admissions and full workflow never manufacture focused variables or omit controlled cases",
 "discovered future focused-only guards fail planning until their actual full admission is implemented",
 "the real local scope guard refuses a complete native inventory rather than executing a narrowed gate",
 "hybrid capability binds the conjunction of actual host, owned database and identical same-run build",
 "final independent build verification refuses a native unit that exercised different compiled bytes",
 "Access native-owner and paired notification diagnostics retain isolated authenticated jobs and their exact owned source closure",
 "Attendance owned child and pidfd proof cannot share a job or omit its actual Python/SQL/source owners",
 "singleton source limits grant only the exact Tamil member a bounded 8 MiB read",
 "both Rewards jobs retain and hash the complete large Tamil dependency without a generic limit increase",
 "Rewards native policy and original read family retain complete isolated source-bound jobs",
 "only the exact five delegated entries may use the shared FIRST actual singleton admission owner",
 "shared module JIT diagnostic owns one unchanged controlled database and cannot omit any actual imported source"
] as const;
it('executes all51 exact singleton profile controller cases with no skipped or substituted source-admission control',()=>{
 const child=spawnSync(process.execPath,['--test','--test-reporter=tap','.github/ci/singleton-profiles.test.mjs'],{
  cwd:root,encoding:'utf8',timeout:25000,maxBuffer:1024*1024,
 });
 process.stdout.write(child.stdout??'');
 process.stderr.write(child.stderr??'');
 expect(child.error).toBeUndefined();expect(child.signal).toBeNull();expect(child.status).toBe(0);
 const output=child.stdout;expect(typeof output).toBe('string');expect(output.length).toBeGreaterThan(0);
 expect(output).not.toMatch(/^not ok\b/m);expect(output).not.toMatch(/^(?:ok|not ok)\s+[0-9]+.*#\s*(?:SKIP|TODO)\b/im);
 expect([...output.matchAll(/^# Subtest: (.+)$/gm)].map(row=>row[1])).toEqual([...expected]);
 expect([...output.matchAll(/^ok ([0-9]+) - (.+)$/gm)].map(row=>({number:Number(row[1]),name:row[2]})))
  .toEqual(expected.map((name,index)=>({number:index+1,name})));
 expect(output.match(/^1\.\.51$/gm)).toHaveLength(1);
 for(const [key,value]of Object.entries({tests:51,suites:0,pass:51,fail:0,cancelled:0,skipped:0,todo:0})){
  const rows=[...output.matchAll(new RegExp('^# '+key+' ([0-9]+)$','gm'))];
  expect(rows).toHaveLength(1);expect(Number(rows[0][1])).toBe(value);
 }
});
