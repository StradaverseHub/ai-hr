/** Run with the installation's private DATABASE_URL and a current, authorized operator context:
 * node --conditions=react-server --import tsx scripts/backfill-reward-person-history.ts 
 *   --context=/private/path/current-session.json --unit=UUID [--apply]
 * Dry-run is the default. One unit per invocation bounds work and retains mismatch evidence.
 * Never run this as part of a migration or treat deployment as proof it ran. */
import {readFileSync} from 'node:fs';
import {z} from 'zod';

async function main(){
 process.env.AIHR_DB_PROCESS_ROLE='worker';process.env.AIHR_DB_POOL_MAX='2';
 const argument=(name:string)=>process.argv.find(value=>value.startsWith(`--${name}=`))?.slice(name.length+3);
 const path=argument('context'),unitId=z.uuid().parse(argument('unit'));
 if(!path)throw Error('Pass --context=/private/path/current-session.json and --unit=UUID.');
 const input=z.object({tenantId:z.uuid(),userId:z.uuid(),personId:z.uuid().nullable().optional(),roles:z.array(z.string()),
  grants:z.array(z.object({role:z.string(),companyId:z.uuid().nullable()})).optional()}).parse(JSON.parse(readFileSync(path,'utf8')));
 const {backfillRewardPersonHistory}=await import('../packs/rewards/person-history-backfill');
 const report=await backfillRewardPersonHistory({...input,entitlementsExempt:'sweeps'},unitId,process.argv.includes('--apply'));
 process.stdout.write(JSON.stringify(report,null,2)+'\n');
 if(report.refused.length)process.exitCode=2;
}
main().catch(error=>{process.stderr.write((error instanceof Error?error.message:'Reward history backfill failed.')+'\n');process.exitCode=1;});
