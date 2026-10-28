/** Delivery reads bind the design to an existing exact lease; callers cannot supply a tenant. */
import {client} from '../../db/client';
import {emailDesignEnvelope,type EmailDesignEnvelope} from './model';
export async function accountEmailDesign(deliveryId:string,leaseToken:string):Promise<EmailDesignEnvelope>{
 const [row]=await client`select app.email_design_account(${deliveryId}::uuid,${leaseToken}::uuid) as design`;
 return emailDesignEnvelope.parse(row?.design);
}
