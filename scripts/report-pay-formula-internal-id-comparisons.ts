/**
 * Which saved Pay Formulas compare an internal-ID Personnel field with text that is not a UUID?
 *
 * `{#EmployeeProfile}("companyId")` is the company's internal ID (a UUID). A formula written as
 * `If {#EmployeeProfile}("companyId") = "<company code>" Then ...` never matches, so every employee takes
 * the Else branch. "Checks before saving" now blocks that on a changed formula, but formulas already
 * saved keep their revisions: applied revisions are immutable history and are NOT rewritten here or
 * anywhere else. This report lists the current revision of each saved (not deleted) formula that has the
 * problem, so the operator can tell the owner which formulas to correct (companyCode for the company
 * code, companyName for the legal name).
 *
 * READ-ONLY: no insert, update or delete, and the whole read runs inside a READ ONLY transaction.
 * OUTPUT: formula code, revision number, line/column, the field and the check severity only. The
 * compared text, descriptions, formula source and tenant names are never printed; tenants are shown as
 * a run-local number so separate tenants' formulas are not mixed together.
 *
 * Run (the owner role reads across tenants):
 *   MIGRATION_DATABASE_URL=... node --import tsx scripts/report-pay-formula-internal-id-comparisons.ts [--tenant=<uuid>]
 * Exit code 0 = nothing found, 3 = formulas need correcting, 1 = could not run.
 */
import {sql} from 'drizzle-orm';
import {createDb} from '../db/client';
import {diagnosePayFormula} from '../lib/pay-formula-diagnostics';

export type SavedFormulaRow={tenantId:string;formulaCode:string;ordinal:number;source:string};
export type InternalIdFinding={tenant:number;formulaCode:string;revision:number;line:number;column:number;field:string;severity:'error'|'warning'};

/** Pure: the findings for already-read rows. Only the reported fields leave this function. */
export function internalIdComparisonFindings(rows:readonly SavedFormulaRow[]):InternalIdFinding[]{
 const tenants=new Map<string,number>(),out:InternalIdFinding[]=[];
 for(const row of rows){
  for(const d of diagnosePayFormula(row.source))if(d.code==='internal_id_compared'){
   if(!tenants.has(row.tenantId))tenants.set(row.tenantId,tenants.size+1);
   out.push({tenant:tenants.get(row.tenantId)!,formulaCode:row.formulaCode,revision:row.ordinal,line:d.line,column:d.column,field:d.name??'',severity:d.severity});
  }
 }
 return out;
}

async function main(){
 const ownerUrl=process.env.MIGRATION_DATABASE_URL;
 if(!ownerUrl){console.error('This report requires MIGRATION_DATABASE_URL (the owner role) to read every tenant.');process.exit(1);}
 const tenantArg=process.argv.find(arg=>arg.startsWith('--tenant='))?.slice('--tenant='.length);
 if(tenantArg!==undefined&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantArg)){console.error('--tenant must be a tenant UUID.');process.exit(1);}
 const owner=createDb(ownerUrl,{max:1});
 try{
  const rows=await owner.db.transaction(async tx=>{
   await tx.execute(sql`set transaction read only`);
   // The current revision of every saved formula, as app.pay_formula_saved resolves it: the highest
   // ordinal, excluding formulas with a 'deleted' event.
   return tx.execute<SavedFormulaRow>(sql`select f.tenant_id as "tenantId",f.formula_id as "formulaCode",r.ordinal,r.source
    from pay_formula f
    join lateral(select rev.ordinal,rev.source from pay_formula_revision rev where rev.formula_id=f.id and rev.tenant_id=f.tenant_id order by rev.ordinal desc limit 1) r on true
    where not exists(select 1 from pay_formula_event e where e.formula_id=f.id and e.tenant_id=f.tenant_id and e.kind='deleted')
      ${tenantArg?sql`and f.tenant_id=${tenantArg}::uuid`:sql``}
    order by f.tenant_id,f.formula_id`);
  });
  const findings=internalIdComparisonFindings(rows);
  console.log(`Checked ${rows.length} saved formula(s).`);
  if(!findings.length){console.log('No saved formula compares an internal ID with a code or name.');return 0;}
  console.log('These saved formulas compare an internal ID with text that is not an ID, so the comparison never matches.');
  console.log('Correct them by hand (companyCode for the company code, companyName for the legal name); saved revisions are not changed by this report.');
  for(const f of findings)console.log(`tenant ${f.tenant}\t${f.formulaCode}\trevision ${f.revision}\tline ${f.line}, column ${f.column}\t${f.field}\t${f.severity==='error'?'blocks saving':'warning'}`);
  return 3;
 }finally{await owner.client.end();}
}

if(process.argv[1]?.endsWith('report-pay-formula-internal-id-comparisons.ts'))main().then(code=>process.exit(code),error=>{console.error(error instanceof Error?error.message:String(error));process.exit(1);});
