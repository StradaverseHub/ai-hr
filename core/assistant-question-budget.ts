/** Legacy Assistant question quota: source-owned intent metadata, with existing model-run reservations
 * supplying token exposure. No prompt/content or parallel provider-usage ledger is stored here. */
import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {AiAllowanceError,AiGatewayError,type ResolvedAiConfig} from '../lib/ai/types';
import {todayInKualaLumpur} from '../lib/hr-date';
import {withAiAdmissionCheck} from './ai-governance';

export type AssistantQuestionBudget=Readonly<{readonly __assistantQuestionBudget?:never}>;
type Owned={principal:string;rootId:string;period:string|null};
const owned=new WeakMap<object,Owned>();
const configurations=new WeakMap<object,{period:string;reservation:AssistantQuestionBudget}>();
const principal=(ctx:SessionContext)=>JSON.stringify([ctx.tenantId,ctx.userId,ctx.personId??null,ctx.roles??null,ctx.grants??null]);
async function statement<T>(run:()=>Promise<T>):Promise<T>{
 try{return await run();}catch{throw new AiGatewayError('The Assistant question budget could not be confirmed.');}
}
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export class AssistantQuestionBudgetError extends AiAllowanceError{
 constructor(readonly budgetCode:'budget_daily'|'budget_monthly'){
  super(budgetCode==='budget_daily'?'daily_limit':'monthly_limit');
  this.name='AssistantQuestionBudgetError';
 }
}
/** Only the native question-root issuer calls this. SQL independently verifies ownership and same-Tx issue. */
export function issueAssistantQuestionBudget(ctx:SessionContext,rootId:string):AssistantQuestionBudget{
 if(!ctx.userId||!UUID.test(rootId))throw new AiGatewayError('The Assistant question budget could not be confirmed.');
 const token=Object.freeze({});owned.set(token,{principal:principal(ctx),rootId,period:null});return token;
}
function binding(ctx:SessionContext,token:AssistantQuestionBudget){
 const row=owned.get(token);
 if(!row||row.principal!==principal(ctx))throw new AiGatewayError('The Assistant question budget could not be confirmed.');
 return row;
}
/** Commits with the native question intent before transport. No transaction spans provider work. */
export async function bindAssistantQuestionBudgetTx(tx:Tx,ctx:SessionContext,configuration:ResolvedAiConfig,token:AssistantQuestionBudget){
 const row=binding(ctx,token);
 if(row.period!==null)throw new AiGatewayError('The Assistant question budget is already bound.');
 const [reserved]=await statement(()=>tx.execute<{period:string;reserved_at:string|Date;blocked_reason:string|null}>(sql`select * from app.assistant_question_budget_reserve(${row.rootId}::uuid)`));
 if(reserved?.blocked_reason==='budget_daily'||reserved?.blocked_reason==='budget_monthly')throw new AssistantQuestionBudgetError(reserved.blocked_reason);
 if(!reserved||reserved.blocked_reason!==null||!/^\d{4}-\d{2}$/.test(reserved.period)
  ||!Number.isFinite(new Date(reserved.reserved_at).getTime())||todayInKualaLumpur(new Date(reserved.reserved_at)).slice(0,7)!==reserved.period)throw new AiGatewayError('The Assistant question budget could not be confirmed.');
 row.period=reserved.period;
 const bounded=withAiAdmissionCheck(configuration,'hr_assistant',async(carrier,request)=>{
  if(request.operation!=='conversation')throw new AiGatewayError('The Assistant question operation could not be confirmed.');
  const [result]=await statement(()=>carrier.execute<{allowed:boolean;blocked_reason:string|null}>(sql`select * from app.assistant_question_budget_admit(${row.rootId}::uuid,${request.reservedTokens}::bigint)`));
  if(result?.blocked_reason==='budget_monthly')throw new AssistantQuestionBudgetError('budget_monthly');
  if(result?.allowed!==true||result.blocked_reason!==null)throw new AiGatewayError('The Assistant question budget could not be confirmed.');
 });
 configurations.set(bounded,{period:reserved.period,reservation:token});
 return {configuration:bounded,period:reserved.period,reservation:token};
}
/** Same transaction as the canonical exchange and assistant_usage update. Unknown run usage remains held. */
export async function completeAssistantQuestionBudgetTx(tx:Tx,ctx:SessionContext,token:AssistantQuestionBudget,exchangeId:string){
 const row=binding(ctx,token);
 if(!row.period||!UUID.test(exchangeId))throw new AiGatewayError('The Assistant question accounting could not be confirmed.');
 await statement(()=>tx.execute(sql`select app.assistant_question_budget_complete(${row.rootId}::uuid,${exchangeId}::uuid)`));
}

/** Only the native root issuer's returned configuration carries a committed question quota. */
export function assistantQuestionBudgetBinding(ctx:SessionContext,configuration:ResolvedAiConfig){
 const value=configurations.get(configuration);
 if(!value)throw new AiGatewayError('The Assistant question budget could not be confirmed.');
 binding(ctx,value.reservation);return value;
}
