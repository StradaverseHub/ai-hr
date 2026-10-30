'use server';
import {revalidatePath} from 'next/cache';
import {getTranslations} from 'next-intl/server';
import {getSession} from '@/lib/session';
import {getPayFormula,savePayFormula,testPayFormula,setPayFormulaActive,deletePayFormula,saveFormulaAccumulationGroup} from '@/packs/payroll/service';
import {PayFormulaError,type PayFormulaContext,type PayFormulaMethod} from '@/lib/pay-formula-model';
import {PayFormulaError as FormulaLanguageError} from '@/lib/pay-formula-language';
const PAGE='/payroll/formula-builder';
export type FormulaActionResult<T>={ok:true;value:T}|{ok:false;error:string;line?:number;column?:number};
async function execute<T>(operation:()=>Promise<T>):Promise<FormulaActionResult<T>>{
 try{return {ok:true,value:await operation()};}catch(error){
  if(error instanceof PayFormulaError||error instanceof FormulaLanguageError){const position=error.message.match(/line (\d+), column (\d+)/);return {ok:false,error:error.message,...(position?{line:Number(position[1]),column:Number(position[2])}:{})};}
  console.error('[pay-formula] operation failed',error instanceof Error?error.name:'unknown');const t=await getTranslations('payFormula');return {ok:false,error:t('unexpectedError')};
 }
}
export async function saveFormulaAction(input:{id?:string;expectedRevisionId?:string;formulaId:string;description:string;method:PayFormulaMethod;source:string}){
 return execute(async()=>{const ctx=await getSession();const saved=await savePayFormula(ctx,{id:input.id,expectedRevisionId:input.expectedRevisionId,formulaId:input.formulaId,description:input.description,method:input.method,source:input.source});revalidatePath(PAGE);revalidatePath(PAGE+'/'+saved.id);const formula=await getPayFormula(ctx,saved.id);if(!formula){const t=await getTranslations('payFormula');throw new PayFormulaError(t('savedUnavailable'));}return formula;});
}
export async function testFormulaAction(input:{id:string;revisionId:string;context:PayFormulaContext}){
 return execute(async()=>{const ctx=await getSession();const context={companyId:input.context.companyId,employmentId:input.context.employmentId,period:input.context.period,cycleId:input.context.cycleId,asOf:input.context.asOf,currentCode:input.context.currentCode,input:input.context.input};const test=await testPayFormula(ctx,{id:input.id,revisionId:input.revisionId,context});const formula=await getPayFormula(ctx,input.id);revalidatePath(PAGE);return {test,formula};});
}
export async function formulaStateAction(input:{id:string;revisionId?:string;testId?:string;active:boolean}){
 return execute(async()=>{const ctx=await getSession();await setPayFormulaActive(ctx,{id:input.id,revisionId:input.revisionId,testId:input.testId,active:input.active});revalidatePath(PAGE);revalidatePath(PAGE+'/'+input.id);return await getPayFormula(ctx,input.id);});
}
export async function deleteFormulaAction(input:{id:string;reason:string}){
 return execute(async()=>{await deletePayFormula(await getSession(),{id:input.id,reason:input.reason});revalidatePath(PAGE);return {id:input.id};});
}
export async function saveAccumulationAction(input:{code:string;members:string[]}){
 return execute(async()=>{const saved=await saveFormulaAccumulationGroup(await getSession(),{code:input.code,members:input.members});revalidatePath(PAGE);return saved;});
}
export async function searchFormulaEmployeesAction(input:{query:string;companyId:string}){
 return execute(async()=>{const {searchPayFormulaEmployees}=await import('@/packs/payroll/service');return await searchPayFormulaEmployees(await getSession(),input.query,input.companyId);});
}
