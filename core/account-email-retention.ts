/** Installation-wide delivery metadata policy; account and security audit owners are untouched. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {withTenant,type SessionContext} from '../db/client';
import type {IdentityEmailActor} from '../lib/identity/email-model';

export type AccountEmailRetention={days:number|null;revision:number;lastRunAt:string|null;lastDeleted:number};
function checkActor(ctx:SessionContext,actor:IdentityEmailActor){
 if(actor.userId!==ctx.userId||actor.tenantId!==ctx.tenantId)throw Error('Email administrator identity does not match the session.');
}
export async function readAccountEmailRetention(ctx:SessionContext,actor:IdentityEmailActor):Promise<AccountEmailRetention>{
 checkActor(ctx,actor);
 const [row]=await withTenant(ctx,tx=>tx.execute<{days:number|null;revision:number;last_run_at:Date|null;last_deleted:number}>(sql`select * from app.account_email_retention_view(${actor.issuer},${actor.subject})`));
 if(!row)throw Error('Email retention policy unavailable.');
 return {days:row.days,revision:row.revision,lastRunAt:row.last_run_at?new Date(row.last_run_at).toISOString():null,lastDeleted:row.last_deleted};
}
const policyInput=z.object({days:z.number().int().min(1).max(3650).nullable(),revision:z.number().int().nonnegative(),acknowledged:z.boolean()}).strict();
export async function saveAccountEmailRetention(ctx:SessionContext,actor:IdentityEmailActor,input:z.infer<typeof policyInput>):Promise<void>{
 checkActor(ctx,actor);const value=policyInput.parse(input);
 if(value.days!==null&&!value.acknowledged)throw Error('Acknowledge permanent deletion before enabling retention.');
 await withTenant(ctx,tx=>tx.execute(sql`select app.account_email_retention_save(${actor.issuer},${actor.subject},${value.days},${value.revision},${value.acknowledged})`));
}
