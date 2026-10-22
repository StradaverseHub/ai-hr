/** Non-content aggregate observations, separate from business events and billing usage. */
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {homeCardInteractions} from '../lib/employee-home-analytics';
import {EMPLOYEE_HOME_CARDS,type EmployeeHomeCard} from '../lib/employee-home';
export function recordHomeCardInteractions(ctx:SessionContext,raw:unknown){
 const events=homeCardInteractions(raw);
 return withTenant(ctx,tx=>tx.execute(sql`SELECT app.record_home_card_interactions(${JSON.stringify(events)}::jsonb)`));
}
/** Fixed30 civil days, no posted tenant/company or person drill-down. SQL repeats current group authority. */
export async function readHomeCardInteractions(ctx:SessionContext){
 return withTenant(ctx,async tx=>{
  const rows=await tx.execute<{card:string;action:string;interactions:string}>(sql`SELECT * FROM app.home_card_interactions_summary()`);
  const result=EMPLOYEE_HOME_CARDS.map(card=>({card,views:0,clicks:0}));
  for(const row of rows){
   const target=result.find(value=>value.card===row.card),count=Number(row.interactions);
   if(!target||!['view','click'].includes(row.action)||!/^\d+$/.test(row.interactions)||!Number.isSafeInteger(count))throw Error('Home usage unavailable');
   target[row.action==='view'?'views':'clicks']=count;
  }
  return result as {card:EmployeeHomeCard;views:number;clicks:number}[];
 },{readOnlySnapshot:true});
}
