/** ADR-0163: operator-only reconciliation of independently verified original document metadata.
 * Dry-run by default. This script never derives an original value from today's employee master.
 */
import {readFileSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {z} from 'zod';
import {and,eq,sql} from 'drizzle-orm';
import {createDb,type SessionContext} from '../db/client';
import {actorOf,appendEvent} from '../db/events';
import {appUser,roleAssignment,informationPayslipSnapshot} from '../db/schema';
import {lockEmploymentStatutoryOwnerTx} from '../core/org';
import {isCalendarDate} from '../lib/calendar-date';
import {PERSONNEL_EMPLOYMENT_TYPES} from '../lib/personnel-choice-vocabulary';
import {pgSqlState} from '../lib/db-error';
const date=z.string().refine(isCalendarDate,'A real YYYY-MM-DD date is required.');
const original=z.object({grade:z.string().trim().min(1).max(200).nullable(),employmentType:z.enum(PERSONNEL_EMPLOYMENT_TYPES).nullable(),hiredOn:date,joinDate:date.nullable()}).strict();
const manifestSchema=z.object({version:z.literal(1),tenantId:z.uuid(),actorUserId:z.uuid(),verifiedOriginals:z.literal(true),
 items:z.array(z.object({payslipId:z.uuid(),employmentId:z.uuid(),companyId:z.uuid(),original,
  evidence:z.array(z.object({path:z.string().min(1),sha256:z.string().regex(/^[a-f0-9]{64}$/),reference:z.string().trim().min(3).max(200)}).strict()).min(1).max(8)}).strict()).min(1).max(200)}).strict();
export type InformationReconciliationManifest=z.infer<typeof manifestSchema>;
/** Verifies original files locally; bytes and private filesystem paths never enter the database. */
export function readVerifiedInformationManifest(raw:unknown,baseDirectory=process.cwd()):InformationReconciliationManifest{
 const manifest=manifestSchema.parse(raw),ids=new Set<string>();
 for(const item of manifest.items){
  if(ids.has(item.payslipId))throw new Error('A payslip occurs more than once.');ids.add(item.payslipId);
  if(item.original.joinDate&&item.original.joinDate<item.original.hiredOn)throw new Error('Join Date precedes Group Join Date.');
  for(const evidence of item.evidence){const path=resolve(baseDirectory,evidence.path),size=statSync(path).size;if(size<1||size>10485760)throw new Error('Each original evidence file must contain 1 byte to 10 MB.');
   const digest=createHash('sha256').update(readFileSync(path)).digest('hex');if(digest!==evidence.sha256)throw new Error('An original evidence file does not match its verified checksum.');}
 }
 return manifest;
}
/** storage MUST be the operator's owner connection, not the application's runtime role. */
export async function reconcileInformationSnapshots(storage:ReturnType<typeof createDb>,manifest:InformationReconciliationManifest,apply=false){
 const [user]=await storage.db.select({id:appUser.id,personId:appUser.personId}).from(appUser).where(and(eq(appUser.tenantId,manifest.tenantId),eq(appUser.id,manifest.actorUserId)));
 if(!user)throw new Error('The named operator is not a user of this tenant.');
 const grants=await storage.db.select({role:roleAssignment.role,companyId:roleAssignment.companyId}).from(roleAssignment).where(and(eq(roleAssignment.tenantId,manifest.tenantId),eq(roleAssignment.appUserId,user.id)));
 const ctx:SessionContext={tenantId:manifest.tenantId,userId:user.id,personId:user.personId,roles:[...new Set(grants.map(g=>g.role))],grants};
 return storage.withTenant(ctx,async tx=>{
  const [database]=await tx.execute<{role:string}>(sql`select current_user as role`);if(database.role==='ai_hr_app')throw new Error('Use the private operator connection for reconciliation.');
  await tx.execute(sql`select app.access_workforce_write_lock()`);
  let missing=0;const evidenceRecords:unknown[]=[];
  for(const item of [...manifest.items].sort((a,b)=>a.employmentId.localeCompare(b.employmentId)||a.payslipId.localeCompare(b.payslipId))){
   await lockEmploymentStatutoryOwnerTx(tx,item.employmentId);
   const [subject]=await tx.execute<{id:string}>(sql`select p.id from payslip p join payroll_batch b on b.id=p.batch_id join employment e on e.id=p.employment_id
    where p.id=${item.payslipId}::uuid and p.employment_id=${item.employmentId}::uuid and b.company_id=${item.companyId}::uuid
    and p.tenant_id=${manifest.tenantId}::uuid and b.tenant_id=p.tenant_id and e.tenant_id=p.tenant_id
    and app.principal_snapshot_current() and app.is_admin_for(b.company_id) and app.is_admin_for(e.company_id)
    and app.access_workforce_employment(e.id,'workforce.maintain') for update of p,e`);
   if(!subject)throw new Error('A payslip binding or operator permission changed. Nothing was reconciled.');
   const [existing]=await tx.select().from(informationPayslipSnapshot).where(eq(informationPayslipSnapshot.payslipId,item.payslipId));
   if(existing){
    for(const field of ['grade','employmentType','hiredOn','joinDate'] as const)if(existing[field]!==item.original[field])throw new Error('A retained original snapshot differs from the manifest. It cannot be overwritten.');
    continue;
   }
   missing++;
   const [metadata]=await tx.execute<{value:Record<string,unknown>}>(sql`select app.information_document_metadata(${item.payslipId}::uuid) as value`);
   if(!metadata?.value)throw new Error('The document identity could not be preserved.');
   if(apply)await tx.insert(informationPayslipSnapshot).values({tenantId:manifest.tenantId,payslipId:item.payslipId,employmentId:item.employmentId,companyId:item.companyId,...item.original,documentMetadata:{...metadata.value,jobGrade:item.original.grade,employmentType:item.original.employmentType},recordedBy:user.id});
   evidenceRecords.push({payslipId:item.payslipId,employmentId:item.employmentId,companyId:item.companyId,original:item.original,evidence:item.evidence.map(e=>({reference:e.reference,sha256:e.sha256}))});
  }
  if(apply&&missing)await appendEvent(tx,{tenantId:manifest.tenantId,aggregateType:'information-reconciliation',aggregateId:manifest.items[0].payslipId,eventType:'employment.information.snapshot-reconciled',actor:actorOf(ctx),payload:{verifiedOriginals:true,snapshots:evidenceRecords}});
  return {mode:apply?'applied':'dry-run',checked:manifest.items.length,missing,alreadyPreserved:manifest.items.length-missing};
 });
}
async function main(){
 const file=process.argv[2];if(!file)throw new Error('Usage: reconcile-information-snapshots.ts manifest.json [--apply --acknowledge-verified-originals --expected-database NAME]');
 const apply=process.argv.includes('--apply'),expectedAt=process.argv.indexOf('--expected-database'),expected=expectedAt>=0?process.argv[expectedAt+1]:undefined;
 if(apply&&(!process.argv.includes('--acknowledge-verified-originals')||!expected))throw new Error('Applying requires an explicit original-evidence acknowledgement and the expected database name.');
 const manifest=readVerifiedInformationManifest(JSON.parse(readFileSync(resolve(file),'utf8')),resolve(file,'..'));
 if(!process.env.MIGRATION_DATABASE_URL)throw new Error('The private operator database connection is required.');
 const storage=createDb(process.env.MIGRATION_DATABASE_URL,{max:1});
 try{const [database]=await storage.client`select current_database() as name`;if(expected&&database.name!==expected)throw new Error('The actual database does not match the expected target.');console.log(JSON.stringify(await reconcileInformationSnapshots(storage,manifest,apply)));}
 finally{await storage.client.end();}
}
if(process.argv[1]?.endsWith('/reconcile-information-snapshots.ts'))main().catch(error=>{const code=pgSqlState(error);console.error(code?'Reconciliation failed; the transaction was rolled back. Database code '+code:error instanceof Error?error.message:'Reconciliation failed.');process.exitCode=1;});
