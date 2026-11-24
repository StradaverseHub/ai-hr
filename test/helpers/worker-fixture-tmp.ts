/** Private temporary root for the bank-import worker Python fixtures.
 *
 * The worker fences (deploy/systemd/bank_import_worker_fences_v1.py, canonical_directory) refuse when any ancestor of a
 * guarded root changes its metadata while it is being opened. That is right for an installation, whose ancestors are
 * quiet, but under the shared /tmp every other test that creates or removes a temporary entry changes /tmp itself, so
 * full release gates refused intermittently with "root ancestor changed while opening" (gates 45326625307 and
 * 45339095373 on 24 November 2026; each fixture passed alone). The fixtures therefore get a TMPDIR whose ancestors no
 * other test writes: one directory per fixture under the runner's home directory, created before the fixture starts.
 * The fence itself is unchanged.
 */
import {mkdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

export const WORKER_FIXTURE_TMP_ROOT='.aihr-worker-fixture-tmp';

export function workerFixtureEnv(fixture:string):NodeJS.ProcessEnv{
 if(!/^[a-z][a-z0-9-]{0,63}$/.test(fixture))throw Error('Worker fixture temporary directory needs a plain name');
 const dir=join(homedir(),WORKER_FIXTURE_TMP_ROOT,fixture);
 mkdirSync(dir,{recursive:true,mode:0o700});
 return {...process.env,TMPDIR:dir};
}
