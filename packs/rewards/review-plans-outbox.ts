/** Physical worker only. A bounded native outbox consumer; no captured human permissions or external I/O. */
import type postgres from 'postgres';
export async function runRewardPlanCompanyTick(owner:postgres.Sql):Promise<boolean>{
 return owner.begin(async tx=>{const[r]=await tx<{created:number}[]>`select app.reward_review_plan_company_tick() as created`;return(r?.created??0)>0;}) as Promise<boolean>;
}
