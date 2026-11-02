/** Hosted diagnostic only. Closed numeric aggregates; no SQL, identity, route or data fields. */
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {createTransactionTimingCollector} from './transaction-timing-collector.mjs';
assert.equal(process.env.GITHUB_ACTIONS,'true');
assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');
assert.equal(process.env.GITHUB_REPOSITORY,'StradaverseHub/ai-hr');
assert.equal(process.platform,'linux');
const file=process.env.PERF_TRANSACTION_PROFILE_FILE;
assert(file?.startsWith(process.env.RUNNER_TEMP+'/system-performance-evidence/'));
const collector=createTransactionTimingCollector();
globalThis.__aihrTransactionTiming=event=>collector.record(event);
const save=()=>{try{writeFileSync(file,JSON.stringify(collector.snapshot()));}catch{}};
setInterval(save,2000).unref();
process.on('exit',save);
save();
