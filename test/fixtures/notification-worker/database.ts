/** Exact disposable hosted worker binding. Names come from the test harness owner,
 * never a permissive database-name pattern or the migration login's spelling. */
import {workerDb} from '../../db-names';
export function notificationWorkerFixtureDatabase(
 migration=process.env.TEST_MIGRATION_DATABASE_URL,
 app=process.env.TEST_DATABASE_URL,
){
 if(process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_ENVIRONMENT!=='github-hosted')throw Error('Standard hosted notification fixture required');
 const poolId=process.env.VITEST_POOL_ID??process.env.VITEST_WORKER_ID;
 if(!poolId||!(/^[1-9][0-9]*$/).test(poolId)||process.env.WORKER_DB==='0')throw Error('An isolated canonical test worker is required');
 const database=workerDb(poolId),namespace=process.env.TEST_DB_NAMESPACE??'';
 const parse=(raw:string|undefined)=>{
  if(!raw)throw Error('Both canonical test database URLs are required');
  let url:URL;try{url=new URL(raw);}catch{throw Error('A valid canonical test database URL is required');}
  if(!['postgres:','postgresql:'].includes(url.protocol)||url.hostname!=='127.0.0.1'||url.pathname!==`/${database}`||url.search||url.hash)
   throw Error('Notification fixture must bind the exact loopback canonical worker database');
  return url;
 };
 const migrationUrl=parse(migration),appUrl=parse(app);
 if(migrationUrl.port!==appUrl.port)throw Error('Notification fixture database endpoints must match');
 return{database,namespace,poolId,migrationUrl,appUrl};
}
