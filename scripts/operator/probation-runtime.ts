/** Owner-only operation on the installed, verified release. Without --apply, it performs only target checks. */
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {sql} from 'drizzle-orm';
import {internalConfig} from '../../lib/internal-auth/config';
import {assertProbationDeploymentTarget,parseProbationRuntimeTarget,ProbationRuntimeRefused} from './probation-runtime-target';

const usage=`On the verified installation, with its existing owner environment:
  node --conditions=react-server --import tsx scripts/operator/probation-runtime.ts \\
    --operation activate|pause|resume-legacy --tenant UUID --company UUID \\
    --origin HTTPS_ORIGIN --source FULL_SHA --build BUILD_ID
Without --apply the command reports target identity only. Apply additionally requires
--database-identity SHA256 --reference PRIVATE_INSTALLATION_REVIEW_REF --apply,
plus --approval UUID --digest SHA256 for activation/restart or --approval UUID for legacy resumption.
The reference must identify the independent installation and dispatch review. Keep the release lease.`;

async function main(args:readonly string[]){
 const target=parseProbationRuntimeTarget(args);if(!target){console.log(usage);return;}
 if(!process.execArgv.includes('--conditions=react-server'))throw new ProbationRuntimeRefused('Use the installed server runtime: --conditions=react-server.');
 const actualOrigin=internalConfig().origin,root=fileURLToPath(new URL('../..',import.meta.url)),statusFile=fileURLToPath(new URL('../../deploy/deploy-state.sh',import.meta.url));
 const verify=()=>assertProbationDeploymentTarget(execFileSync('bash',[statusFile,'status'],{cwd:root,encoding:'utf8',timeout:5000,maxBuffer:32768}),actualOrigin,target);
 verify();
 const url=process.env.MIGRATION_DATABASE_URL;if(!url)throw new ProbationRuntimeRefused('Use the verified installation owner connection from its environment.');
 const connection=new URL(url);
 const [{createDb},{resolveEntitlementsTx},probation]=await Promise.all([import('../../db/client'),import('../../core/entitlements'),import('../../packs/probation/service')]);
 const owner=createDb(url,{max:1});
 try{
  const ctx={tenantId:target.tenant,roles:[],grants:[],entitlements:await owner.db.transaction(tx=>resolveEntitlementsTx(tx,target.tenant))};
  const identity=await owner.withTenant(ctx,async tx=>{
   const [row]=await tx.execute<{allowed:boolean;company:boolean;dbOid:string;serverAddress:string;serverPort:string}>(sql`select app.probation_storage_runner() as allowed,exists(select 1 from company where tenant_id=${target.tenant}::uuid and id=${target.company}::uuid and archived_at is null) as company,d.oid::text as "dbOid",coalesce(inet_server_addr()::text,'local') as "serverAddress",coalesce(inet_server_port()::text,'local') as "serverPort" from pg_database d where d.datname=current_database()`);
   if(!row?.allowed||!row.company)throw new ProbationRuntimeRefused('The actual no-login database owner and selected current company are required.');
   return createHash('sha256').update(JSON.stringify(['probation-installation/v1',connection.protocol,connection.hostname,connection.port,connection.pathname,row.dbOid,row.serverAddress,row.serverPort])).digest('hex');
  },{readOnlySnapshot:true});
  if(target['database-identity']&&target['database-identity']!==identity)throw new ProbationRuntimeRefused('The database identity differs from the independently reviewed target.');
  if(!target.apply){console.log(JSON.stringify({operation:target.operation,applied:false,origin:actualOrigin,source:target.source,build:target.build,company:target.company,databaseIdentity:identity}));return;}
  const approval=target.approval,review=target.reference;
  if(!review||!target['database-identity'])throw new ProbationRuntimeRefused('An explicit installation review is required.');
  const reference=review+' · source '+target.source+' · build '+target.build+' · database '+identity;
  if(target.operation!=='pause'){
   if(!approval)throw new ProbationRuntimeRefused('Select the exact named review receipt.');
   const matches=await owner.withTenant(ctx,async tx=>{
    const predicate=target.operation==='activate'
     ?sql`select exists(select 1 from probation_cutover where tenant_id=${target.tenant}::uuid and company_id=${target.company}::uuid and id=${approval}::uuid and digest=${target.digest}) as ok`
     :sql`select exists(select 1 from probation_legacy_reconciliation r join probation_case c on c.id=r.case_id and c.tenant_id=r.tenant_id where r.tenant_id=${target.tenant}::uuid and c.company_id=${target.company}::uuid and r.id=${approval}::uuid) as ok`;
    const [row]=await tx.execute<{ok:boolean}>(predicate);return row?.ok===true;
   },{readOnlySnapshot:true});
   if(!matches)throw new ProbationRuntimeRefused('The named review does not belong to the selected installation company.');
  }
  verify();
  if(target.operation==='activate'){
   if(!approval||!target.digest)throw new ProbationRuntimeRefused('Select the exact rehearsal and its content digest.');
   const result=await probation.activatePreparedProbationCutover(ctx,owner,{id:approval,digest:target.digest,installationReceipt:{origin:actualOrigin,reference}});
   console.log(JSON.stringify({operation:target.operation,company:target.company,applied:true,alreadyApplied:result.alreadyApplied,approval}));
  }else if(target.operation==='pause'){
   const changed=await probation.pauseProbationCompany(ctx,owner,{companyId:target.company,receipt:reference});
   console.log(JSON.stringify({operation:target.operation,company:target.company,applied:true,changed}));
  }else{
   if(!approval)throw new ProbationRuntimeRefused('Select the exact separately reviewed legacy request.');
   await probation.applyProbationLegacyReconciliation(ctx,owner,approval);
   console.log(JSON.stringify({operation:target.operation,company:target.company,applied:true,approval,installationReview:review}));
  }
 }finally{await owner.client.end({timeout:5});}
}
if(import.meta.url===pathToFileURL(process.argv[1]??'').href)main(process.argv.slice(2)).catch(error=>{console.error(error instanceof ProbationRuntimeRefused?error.message:'The Probation operation was refused or could not complete. Check the named approval and installed target.');process.exitCode=1;});
