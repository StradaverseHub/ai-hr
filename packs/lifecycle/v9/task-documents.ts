import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { SessionContext } from '../../../db/client';
import {actorOf,appendEvent} from '../../../db/events';
import { withLifecycleTenant } from '../../../core/module-gate';
import { withAccessDisplayRead } from '../../../core/access-configuration-lock';
import type { LifecycleTaskDocumentsPage } from '../../../lib/lifecycle-task-documents';

/** SQL owns authorization, scope, ordering, count and pagination in one shared Access snapshot. */
export async function lifecycleTaskDocuments(ctx: SessionContext, input: { companyIds: string[]; caseId?:string; offset?: number; limit?: number }): Promise<LifecycleTaskDocumentsPage> {
  const query = z.object({companyIds:z.array(z.string().uuid()).max(500),caseId:z.string().uuid().optional(),offset:z.number().int().min(0).max(1000000).default(0),limit:z.number().int().min(1).max(100).default(50)}).parse(input);
  return withAccessDisplayRead(() => withLifecycleTenant(ctx, async tx => {
    const [row] = await tx.execute<{data:LifecycleTaskDocumentsPage}>(sql`select app.lifecycle_task_documents(${query.companyIds}::uuid[],${query.offset},${query.limit},${query.caseId??null}::uuid) as data`);
    return row.data;
  }));
}
/** This command opens an existing released instance; it never saves answers or submits a form. */
export async function openOwnLifecycleDocument(ctx:SessionContext, input:{caseId:string;documentId:string;revision:number}):Promise<void>{
  const value=z.object({caseId:z.string().uuid(),documentId:z.string().min(1).max(120),revision:z.number().int().positive()}).strict().parse(input);
  await withLifecycleTenant(ctx, async tx => {
    const [row]=await tx.execute<{result:{revision:number;employmentId:string;changed:boolean}}>(sql`select app.lifecycle_open_own_document(${value.caseId}::uuid,${value.documentId},${value.revision}) as result`);
    if(row.result.changed)await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'lifecycle-v9-case',aggregateId:value.caseId,eventType:'lifecycle-v9.employeeDocumentOpened',actor:actorOf(ctx),subjectEmploymentId:row.result.employmentId,payload:{caseId:value.caseId,documentId:value.documentId,revision:row.result.revision}});
  });
}
