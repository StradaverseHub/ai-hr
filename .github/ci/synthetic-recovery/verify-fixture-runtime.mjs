import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const [source,verifier,unit]=process.argv.slice(2);
assert(process.platform==='linux'&&process.arch==='x64','Linux x64 fixture runner required');
assert(/^aihr-recovery-fixture-[a-z0-9-]+\.service$/.test(unit),'Dedicated synthetic service required');
const url=new URL(process.env.MIGRATION_DATABASE_URL);
assert(url.protocol==='postgresql:'&&url.hostname==='127.0.0.1'&&url.pathname==='/aihr_recovery_fixture','Dedicated loopback fixture database required');
const {expectedMigrationLedger,LEDGER_QUERY,validateMigrationLedgerRows}=await import(pathToFileURL(verifier));
const systemctl=(...args)=>execFileSync('systemctl',args,{encoding:'utf8',timeout:5000}).trim();
assert.equal(systemctl('is-active',unit),'active');
assert.equal(systemctl('show',unit,'-p','WorkingDirectory','--value'),source);
const pid=systemctl('show',unit,'-p','MainPID','--value');
const restart=Number(systemctl('show',unit,'-p','ExecMainStartTimestampMonotonic','--value'));
assert(/^[1-9][0-9]*$/.test(pid)&&restart>Number(process.env.FIXTURE_ACTIVATION_MONOTONIC_US),'Synthetic service must have started after activation');
const build=readFileSync(join(source,'.next','BUILD_ID'),'utf8').trim();
assert.match(build,/^synthetic-[a-z0-9-]+$/);
const response=await fetch('http://127.0.0.1:3107/health',{signal:AbortSignal.timeout(3000)});
assert.equal(response.status,200);
assert.deepEqual(await response.json(),{build});
const rows=JSON.parse(execFileSync('psql',['-d',url.href,'-X','-qAt','-v','ON_ERROR_STOP=1'],{
 encoding:'utf8',input:LEDGER_QUERY,timeout:20000,
 env:{...process.env,PGOPTIONS:'-c default_transaction_read_only=on -c statement_timeout=10000'},
}));
const ledger=validateMigrationLedgerRows(expectedMigrationLedger(source),rows);
assert.equal(ledger.rows,656);
assert.equal(systemctl('show',unit,'-p','MainPID','--value'),pid);
console.log(JSON.stringify({build,pid,restart,healthStatus:200,ledger}));
