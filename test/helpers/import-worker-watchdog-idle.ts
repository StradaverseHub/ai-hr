/** Child process of test/import-worker-watchdog.test.ts: arms the real watchdog (real timers, default 30 s check)
 * and does nothing else, so the process must end at once if the watchdog's timer is unref'd. */
import {startImportWorkerWatchdog} from '../../lib/import-worker-watchdog';
startImportWorkerWatchdog({limitSeconds:1200}).enter('pause');
console.log('watchdog armed');
