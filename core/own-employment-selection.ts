/** Current live self selection, shared by Home and the existing web clock owner. No salary joins. */
import type {SessionContext,Tx} from '../db/client';
import {withTenant} from '../db/client';
import {myOwnEmploymentSubjectsTx} from './read';
import {selectOwnEmployment,OwnEmploymentSelectionError} from '../lib/own-employment-selection';
export async function ownLiveEmploymentSubjectsTx(tx:Tx,ctx:SessionContext){
 const rows=await myOwnEmploymentSubjectsTx(tx,ctx,{profileEdit:true});
 if(rows.length>20)throw new OwnEmploymentSelectionError();
 return rows.filter(row=>row.companyProof.companyId!==null);
}
export function ownLiveEmploymentSubjects(ctx:SessionContext){return withTenant(ctx,tx=>ownLiveEmploymentSubjectsTx(tx,ctx));}
export async function ownLiveEmploymentTx(tx:Tx,ctx:SessionContext,selected?:string){return selectOwnEmployment(await ownLiveEmploymentSubjectsTx(tx,ctx),selected);}
export function ownLiveEmployment(ctx:SessionContext,selected?:string){return withTenant(ctx,tx=>ownLiveEmploymentTx(tx,ctx,selected));}
