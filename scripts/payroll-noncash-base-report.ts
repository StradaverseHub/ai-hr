/**
 * Board d9ded29c — pre-release affected-employee report (core/payroll-noncash-base-report.ts says what it reads and why).
 * Lists, per company, the employees whose imported or reviewed (Recalculate Income Tax Value) months carry taxable BIK or
 * VOLA that year-to-date PCB income left out, with the missing amounts. Payroll uses it to warn them before the release.
 *
 *   node --env-file=.env.production --import tsx scripts/payroll-noncash-base-report.ts --year=2026
 *   node --env-file=.env.production --import tsx scripts/payroll-noncash-base-report.ts --year=2026 --tenant=<uuid>
 *
 * Needs MIGRATION_DATABASE_URL (the owner role reads every tenant). Every read is one READ ONLY transaction per tenant;
 * the session also sets default_transaction_read_only, so nothing can be written. Run it only on an installation the
 * operator is authorized to report on, and keep the output in the release's private evidence store: it names employee
 * codes and companies (no names, IC numbers or salaries).
 *
 * Exit codes: 0 report printed (affected or not) · 2 bad arguments or the report could not be read.
 */
import postgres from 'postgres';
import {formatNoncashBaseGapReport,noncashBaseGapRowsTx,type NoncashBaseGapRow} from '../core/payroll-noncash-base-report';

async function main(){
 const args=process.argv.slice(2);
 const option=(name:string)=>args.find(a=>a.startsWith(`--${name}=`))?.slice(name.length+3);
 const year=Number(option('year')),tenant=option('tenant');
 if(!Number.isInteger(year)||year<2000||year>2999){console.error('usage: payroll-noncash-base-report.ts --year=YYYY [--tenant=<uuid>]');process.exit(2);}
 if(tenant!==undefined&&!/^[0-9a-f-]{36}$/i.test(tenant)){console.error('--tenant must be a tenant id');process.exit(2);}
 const url=process.env.MIGRATION_DATABASE_URL;
 if(!url){console.error('payroll-noncash-base-report requires MIGRATION_DATABASE_URL.');process.exit(2);}
 const sql=postgres(url,{max:1,connection:{default_transaction_read_only:true,application_name:'payroll-noncash-base-report'}});
 try{
  const tenants=tenant?[tenant]:(await sql<{id:string}[]>`select id::text as id from public.tenant order by id`).map(row=>row.id);
  const rows:NoncashBaseGapRow[]=[];
  for(const id of tenants)rows.push(...await sql.begin('isolation level repeatable read read only',tx=>noncashBaseGapRowsTx(tx,id,year)));
  for(const line of formatNoncashBaseGapReport(year,rows))console.log(line);
 }finally{await sql.end();}
}
main().catch(error=>{console.error(`payroll-noncash-base-report failed: ${(error as Error).name}: ${(error as Error).message}`);process.exit(2);});
