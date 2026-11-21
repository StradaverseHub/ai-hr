import {sql} from 'drizzle-orm';
import type {SqlExecutor} from '../db/sql-executor';
import type {AutomationStepContext} from '../lib/automation/runtime';
/** Private held effect only; user-selected actors or an application EXECUTE grant are never accepted. */
export async function recordContractSharedFallbackTx(tx:SqlExecutor,step:AutomationStepContext,details:readonly {meantFor:string;reason:string}[]){if(!details.length)return;await tx.execute(sql`select app.contract_shared_fallback_record(${step.run.subjectId}::uuid,${step.run.id}::uuid,${step.step.id},${step.step.type},${JSON.stringify(details)}::text::jsonb)`);}
