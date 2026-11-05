/** Owner-only restoration of corrupt historical rows predating the Org Chart database invariant.
 * This helper never disables production guards. DDL and inserts share one owner transaction;
 * success reenables the one named trigger before commit, and failure rolls the DDL back. */
import {sql} from 'drizzle-orm';
import {owner} from '../harness';
import {reportingLine} from '../../db/schema';
export async function restorePreOrgRootReportingLines(rows:(typeof reportingLine.$inferInsert)[]):Promise<void>{
 if(!rows.length)throw new Error('Historical reporting fixture must contain rows.');
 await owner.db.transaction(async tx=>{
  await tx.execute(sql`ALTER TABLE public.reporting_line DISABLE TRIGGER reporting_line_org_chart_root_integrity`);
  await tx.insert(reportingLine).values(rows);
  await tx.execute(sql`ALTER TABLE public.reporting_line ENABLE TRIGGER reporting_line_org_chart_root_integrity`);
 });
}
