/** Normal NODB controls only; these child models do not qualify either native runtime cell. */
import {spawnSync} from 'node:child_process';
import {expect,it} from 'vitest';

it('checks the closed ASCII runtime selection, independent compiled source and complete lifecycle source contracts',()=>{
 const owners=['.github/ci/employee-ascii-runtime-qualification.test.mjs','.github/ci/employee-ascii-compiled-source.test.mjs','.github/ci/employee-lifecycle-sources.test.mjs'];
 const names=[
  'off preserves ordinary focused metadata without creating a runtime cell',
  'binds only two named runtime cells to exact release literals and one complete selector pair',
  'refuses unknown purposes and missing duplicated foreign or expanded selectors',
  'refuses coincident compiler build native provider profiling and restricted-port intent',
  'accepts only all eight exact source cases from two complete result files',
  'refuses failed skipped missing renamed duplicated or foreign cases and suites',
  'binds absolute result filenames to the actual source directory and refuses foreign path interpretations',
  'reconstructs the independent whole historical compiled SQL while binding the distinct current committed template',
  'refuses altered omitted duplicated or already compiled template bytes before native log replay',
  'refuses a swapped or candidate-claimed compiled source identity independently of correct committed template bytes',
  'all five source-registered units retain the actual canonical SQL history and one complete source owner',
  // cd08b6789 (v21 trusted controller) added the archived pre-retirement closure restoration control.
  'historical restoration still reconstructs the exact predecessor from its archived source',
  'coherently rehashed missing critical owners or canonical SQL still refuse independently',
  'duplicated sources and malformed/duplicated native history cannot redefine the complete closure',
 ];
 const result=spawnSync(process.execPath,['--test','--test-reporter=tap','--test-concurrency=1',...owners],{timeout:25000,maxBuffer:1024*1024});
 const stdout=result.stdout??Buffer.alloc(0),stderr=result.stderr??Buffer.alloc(0);
 expect(Buffer.isBuffer(stdout)&&Buffer.isBuffer(stderr)).toBe(true);
 expect(stdout.length+stderr.length).toBeLessThanOrEqual(1024*1024);
 // Preserve actual bounded child output before any success/census guard can fail.
 process.stdout.write(stdout);process.stderr.write(stderr);
 expect(result.error).toBeUndefined();expect(result.signal).toBeNull();expect(result.status).toBe(0);
 const output=stdout.toString('utf8'),subtests=[...output.matchAll(/^# Subtest: (.+)$/gm)].map(match=>match[1]);
 expect(subtests).toHaveLength(14);expect(new Set(subtests).size).toBe(14);expect(subtests.slice().sort()).toEqual(names.slice().sort());
 const passed=[...output.matchAll(/^ok (\d+) - (.+)$/gm)];
 expect(passed).toHaveLength(14);expect(passed.map(match=>Number(match[1]))).toEqual(Array.from({length:14},(_,index)=>index+1));
 expect(passed.map(match=>match[2]).sort()).toEqual(names.slice().sort());
 for(const line of ['1..14','# tests 14','# suites 0','# pass 14','# fail 0','# cancelled 0','# skipped 0','# todo 0']){
  expect(output.split(/\r?\n/).filter(value=>value===line),line).toHaveLength(1);
 }
 expect(output).not.toMatch(/^not ok\b|^Bail out!|^(?:ok|not ok)\b[^\n]*#\s*(?:SKIP|TODO)\b/gmi);
},30000);
