/** Disposable hosted profiler only. The parent sends SIGUSR2 after the measured workload finishes. */
import assert from 'node:assert/strict';
assert.equal(process.env.GITHUB_ACTIONS,'true');
assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');
assert.equal(process.env.GITHUB_REPOSITORY,'StradaverseHub/ai-hr');
assert.equal(process.platform,'linux');
assert(process.execArgv.includes('--cpu-prof'),'Explicit native CPU profiling required');
// Native --cpu-prof flushes on an orderly Node exit; signal termination can discard every sample.
// Keep SIGTERM/SIGINT semantics untouched. This opt-in module never runs in an installed application.
process.once('SIGUSR2',()=>process.exit(0));
