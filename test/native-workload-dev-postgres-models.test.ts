/** Runs the fixed dev-realm source models only. No database or native admission. */
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {expect,it} from 'vitest';

const root=fileURLToPath(new URL('..',import.meta.url));
const names=[
 'dev realm HBA has exact physical scope and preserves the old test worker HBA bytes',
 'private credential grammar refuses any other transport, target, slot or reused password without returning credentials',
 'SCRAM verifier observation consists of exactly three booleans and never verifier strings',
 'independent physical birth must bind exact source, controller, first attempt, run, unit and dev HBA',
 'owner, RLS app and stats roles must use stable distinct dev TCP connections on both observations',
 'observer requires held repeatable read, read-only, connection cap and short statement and lock limits',
 'reserved owner TCP snapshots must independently match the held physical cluster even when endpoint and OIDs match',
 'another repeatable read transaction on the same live observer backend does not retain the held observation',
 'effective observer ACL refuses PUBLIC TEMP, unsafe role edges, table or definer rights and absent reset evidence',
 'ACL observations are bound to the held database and role and refuse unknown inventory bounds',
 'observer ownership and unsafe catalogue access refuse even when ordinary business ACL grants are absent',
 'catalogue routine ACL refuses restored PUBLIC access or extra explicit edges while preserving exact stock stats grants',
 'only closed same-realm aggregate app observations with positive live activity can be retained',
 'actual refusal categories distinguish wrong auth, foreign realm and server-denied privileges',
 'successful observation cannot replace cleanup tied to the held physical birth',
 'native observation statements are finite reads and expose no password or query text',
] as const;

it('runs all 16 exact dev PostgreSQL source models without skips',()=>{
 expect(process.versions.node.split('.')[0]).toBe('22');
 const cap=128*1024;
 const child=spawnSync(process.execPath,[
  '--test','--test-reporter=tap','--experimental-test-isolation=none','.github/ci/native-workload-dev-postgres.test.mjs',
 ],{
  cwd:root,env:{PATH:'/usr/bin:/bin',LC_ALL:'C.UTF-8',TZ:'UTC'},
  timeout:10000,killSignal:'SIGKILL',maxBuffer:cap,stdio:['ignore','pipe','pipe'],
 });
 const stdout=child.stdout??Buffer.alloc(0),stderr=child.stderr??Buffer.alloc(0);
 expect(stdout.length+stderr.length).toBeLessThanOrEqual(cap);
 process.stdout.write(stdout);
 process.stderr.write(stderr);
 expect(child.error).toBeUndefined();
 expect(child.signal).toBeNull();
 expect(child.status).toBe(0);
 expect(stderr.length).toBe(0);
 const lines=stdout.toString('utf8').split(/\r?\n/);
 expect(lines.filter(line=>/^TAP version\b/.test(line))).toEqual(['TAP version 13']);
 expect(lines.filter(line=>/^[ \t]*# Subtest:/.test(line))).toEqual(names.map(name=>'# Subtest: '+name));
 expect(lines.filter(line=>/^[ \t]*(?:ok|not ok)\b/.test(line))).toEqual(names.map((name,index)=>`ok ${index+1} - ${name}`));
 expect(lines.filter(line=>/^[ \t]*[0-9]+\.\./.test(line))).toEqual(['1..16']);
 expect(lines.some(line=>/^[ \t]*Bail out!/i.test(line))).toBe(false);
 const summaries=lines.filter(line=>/^[ \t]*# (?:tests|suites|pass|fail|cancelled|skipped|todo)\b/.test(line));
 expect(summaries.sort()).toEqual(['# tests 16','# suites 0','# pass 16','# fail 0','# cancelled 0','# skipped 0','# todo 0'].sort());
},15000);
