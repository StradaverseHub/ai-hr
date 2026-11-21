import {sql} from 'drizzle-orm';
import type {Tx} from '../db/client';

/** A hire has an authorized company before its new Person has any employment. Never leak that
 * operation context into the next row of a multi-company import. The ordinary workforce guard still runs. */
export async function withSystemLabelCompanyTx<T>(tx:Tx,companyId:string,run:()=>Promise<T>):Promise<T>{
  const [old]=await tx.execute<{value:string|null}>(sql`select current_setting('app.system_label_operation_company',true) as value`);
  await tx.execute(sql`select set_config('app.system_label_operation_company',${companyId},true)`);
  try{return await run();}
  finally{
    // SQL refusals abort their transaction; rollback clears the local setting in that case.
    await tx.execute(sql`select set_config('app.system_label_operation_company',${old?.value??''},true)`).catch(()=>{});
  }
}
