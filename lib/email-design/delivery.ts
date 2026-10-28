/** Delivery reads bind the design to an existing exact lease; callers cannot supply a tenant. */
import {sql} from 'drizzle-orm';
import {client,withTenant,type SessionContext} from '../../db/client';
import {emailDesignEnvelope,type EmailDesignEnvelope} from './model';
export async function accountEmailDesign(deliveryId:string,leaseToken:string):Promise<EmailDesignEnvelope>{
 const [row]=await client`select app.email_design_account(${deliveryId}::uuid,${leaseToken}::uuid) as design`;
 return emailDesignEnvelope.parse(row?.design);
}

/** Recovery's queue is deliberately tenant-anonymous. Only its decrypted, verified principal supplies context. */
export async function recoveryEmailDesign(ctx:SessionContext):Promise<EmailDesignEnvelope>{return withTenant(ctx,async tx=>{
 const [row]=await tx.execute<{design:unknown}>(sql`select app.email_design_authenticated('recovery','en') as design`);
 return emailDesignEnvelope.parse(row?.design);
 });}
