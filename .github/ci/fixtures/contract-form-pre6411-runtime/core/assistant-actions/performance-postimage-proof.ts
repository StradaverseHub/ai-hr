/** Private reviewed-effect expectations. No commitment is an actor capability or public HR fact. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {Tx} from '../../db/client';
const digest=z.string().regex(/^[a-f0-9]{64}$/);
export const PerformancePostimageProof=z.object({version:z.literal(1),unchanged:digest,notes:digest.nullable(),notesMode:z.enum(['preserve','replace']).nullable()}).strict();
export type PerformancePostimageProof=z.infer<typeof PerformancePostimageProof>;
export type PerformancePostimageAction='performance.goal.approve'|'performance.checkin.cancel'|'performance.checkin.complete';
/** Called under native locks before custody seals. Replacement is already normalized by the native
 * JS notes owner; preservation is derived in SQL, never from a caller's purported old notes. */
export async function derivePerformancePostimageTx(tx:Tx,action:PerformancePostimageAction,subjectId:string,mode:'preserve'|'replace'|null=null,replacement:string|null=null){
 const [row]=await tx.execute<{proof:unknown}>(sql`select app.assistant_performance_review_expected(${action},${subjectId}::uuid,${mode},${replacement}) as proof`);return PerformancePostimageProof.parse(row?.proof);
}
/** Read actual persisted rows after UPDATE triggers and again after event triggers. */
export async function assertPerformancePostimageTx(tx:Tx,action:PerformancePostimageAction,subjectId:string,proof:PerformancePostimageProof,completedAt:string|null=null){
 await tx.execute(sql`select app.assistant_performance_review_assert(${action},${subjectId}::uuid,${JSON.stringify(proof)}::jsonb,${completedAt}::timestamptz)`);
}
