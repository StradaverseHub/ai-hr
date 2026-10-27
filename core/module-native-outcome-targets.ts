/** Private source-owned privacy links, never a browser/model DTO. Capture the COMPLETE actual
 * original target set in the canonical effect transaction before terminal custody clears snapshots.
 * A row-version fence does not prove canonical provenance: that remains the trusted caller's job. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../db/client';
import {NATIVE_OUTCOME_ACTIONS,type NativeOutcomeAction} from '../lib/ai/module-native-outcomes';
import {boundNativeOutcomeTransactionTx} from './module-native-outcome-bounds';
const Id=z.uuid().transform(value=>value.toLowerCase());
const Target=z.object({kind:z.enum(['person','employment','lifecycle_case']),id:Id}).strict();
const Source=z.object({action:z.enum(Object.keys(NATIVE_OUTCOME_ACTIONS) as [NativeOutcomeAction,...NativeOutcomeAction[]]),sourceId:Id,eventId:Id}).strict();
export type NativeOutcomePrivacyTarget=Readonly<z.infer<typeof Target>>;
export type NativeOutcomePrivacySource=Readonly<z.infer<typeof Source>>;
const fail=():never=>{throw new Error('Native outcome privacy custody could not be confirmed.');};
function identity(ctx:SessionContext){if(!ctx.userId)return fail();return{tenantId:Id.parse(ctx.tenantId),userId:Id.parse(ctx.userId),personId:ctx.personId?Id.parse(ctx.personId):null};}
/** No artificial subject-count cap: the actual canonical source's complete set is required. SQL
 * adds original private review snapshots, actor PERSON, and effect-time employment->PERSON links. */
export async function captureNativeOutcomeTargetsTx(tx:Tx,supplied:SessionContext,value:NativeOutcomePrivacySource&Readonly<{targets:readonly NativeOutcomePrivacyTarget[]}>):Promise<void>{
 const ctx=identity(supplied),source=Source.parse({action:value.action,sourceId:value.sourceId,eventId:value.eventId});
 const targets=Object.freeze([...new Map(z.array(Target).parse(structuredClone(value.targets)).map(target=>[target.kind+':'+target.id,target])).values()].sort((a,b)=>a.kind.localeCompare(b.kind)||a.id.localeCompare(b.id)));
 await boundNativeOutcomeTransactionTx(tx);
 const [result]=await tx.execute<{captured:boolean}>(sql`select app.native_outcome_targets_capture(${ctx.tenantId}::uuid,${ctx.userId}::uuid,${ctx.personId}::uuid,${source.action},${source.sourceId}::uuid,${source.eventId}::uuid,${JSON.stringify(targets)}::jsonb) as captured`);
 if(result?.captured!==true)return fail();
}
/** Call ONLY in learning association verification, AFTER canonical completed-source verification.
 * Historical missing captures refuse learning; ordinary human completed receipt reopen is unchanged. */
export async function requireNativeOutcomeTargetsTx(tx:Tx,supplied:SessionContext,value:NativeOutcomePrivacySource):Promise<void>{
 const ctx=identity(supplied),source=Source.parse(structuredClone(value));
 await boundNativeOutcomeTransactionTx(tx);
 const [result]=await tx.execute<{complete:boolean}>(sql`select app.native_outcome_targets_require(${ctx.tenantId}::uuid,${ctx.userId}::uuid,${ctx.personId}::uuid,${source.action},${source.sourceId}::uuid,${source.eventId}::uuid) as complete`);
 if(result?.complete!==true)return fail();
}
