/** Prove the packaged module graph reaches native configuration validation, without a database. */
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const [archive,source]=process.argv.slice(2);
assert.match(source??'',/^[a-f0-9]{40}$/);
const target=mkdtempSync(join(tmpdir(),'aihr-worker-startup-'));
try {
 const format=fileURLToPath(new URL('../deploy/systemd/bank_import_worker_format.py',import.meta.url));
 const extract=spawnSync('python3',['-I','-B','-c',`import importlib.util,sys
spec=importlib.util.spec_from_file_location('fmt',sys.argv[1]);fmt=importlib.util.module_from_spec(spec);spec.loader.exec_module(fmt)
fmt.extract_archive(sys.argv[2],sys.argv[3],sys.argv[4])`,format,archive,target,source],{encoding:'utf8',timeout:240000});
 assert.equal(extract.status,0,extract.stderr);
 const result=spawnSync(process.execPath,['--import','tsx','scripts/bank-import-runner.ts','--once'],{
  cwd:target,env:{PATH:process.env.PATH,HOME:target,NODE_ENV:'production',DATABASE_URL:'postgres://nobody:nothing@127.0.0.1:1/no_database',MIGRATION_DATABASE_URL:''},
  encoding:'utf8',timeout:60000,maxBuffer:1024**2,
 });
 assert.equal(result.status,1,result.stdout+result.stderr);
 assert.match(result.stdout+result.stderr,/MIGRATION_DATABASE_URL is required by the import worker\./);
 assert.doesNotMatch(result.stdout+result.stderr,/MODULE_NOT_FOUND|Cannot find module|server-only|createContext/);
 console.log('Extracted immutable bank worker reached native configuration validation.');
} finally {rmSync(target,{recursive:true,force:true});}
