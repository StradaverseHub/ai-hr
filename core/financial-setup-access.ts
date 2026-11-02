/** Maintenance purpose; calculation/reference consumers keep their independent native read course. */
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
export type FinancialSetupOperation='view'|'add'|'edit'|'delete';
export async function payrollCatalogueAccessTx(tx:Tx,operation:FinancialSetupOperation){
 const [row]=await tx.execute<{allowed:boolean}>(sql`select app.financial_setup_catalog_function('payComponents.catalogue',${operation}) as allowed`);
 return row?.allowed===true;
}
export function payrollCatalogueActions(ctx:SessionContext){return withTenant(ctx,async tx=>{
 const [row]=await tx.execute<{view:boolean;add:boolean;edit:boolean;delete:boolean}>(sql`select
 app.financial_setup_catalog_function('payComponents.catalogue','view') as view,app.financial_setup_catalog_function('payComponents.catalogue','add') as add,
 app.financial_setup_catalog_function('payComponents.catalogue','edit') as edit,app.financial_setup_catalog_function('payComponents.catalogue','delete') as delete`);
 return row??{view:false,add:false,edit:false,delete:false};
});}
