/** Existing disposable-owner configuration predicates, no DB or test-framework import. */
import {workerDb} from '../db-names';
export function rewardsAuditWorkerScope(){
 if(process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_ENVIRONMENT!=='github-hosted')throw Error('Standard hosted Rewards prototype required');
 const pool=process.env.VITEST_POOL_ID??process.env.VITEST_WORKER_ID;if(!pool||!/^[1-9][0-9]*$/.test(pool)||process.env.WORKER_DB==='0')throw Error('Isolated canonical Rewards worker required');
 const database=workerDb(pool),namespace=process.env.TEST_DB_NAMESPACE??'';return{pool,database,namespace};
}
export function rewardsAuditWorkerUrl(raw:string|undefined,database:string){if(!raw)throw Error('Both canonical worker URLs required');const url=new URL(raw);if(!['postgres:','postgresql:'].includes(url.protocol)||url.hostname!=='127.0.0.1'||url.pathname!=='/'+database||url.search||url.hash)throw Error('Exact loopback canonical Rewards database required');return url;}
export function rewardsAuditOwnerConfiguration(){
 const {pool,database,namespace}=rewardsAuditWorkerScope(),migration=rewardsAuditWorkerUrl(process.env.TEST_MIGRATION_DATABASE_URL,database),application=rewardsAuditWorkerUrl(process.env.TEST_DATABASE_URL,database);
 if(migration.port!==application.port)throw Error('Rewards endpoint mismatch');return{pool,database,namespace,migration};
}
