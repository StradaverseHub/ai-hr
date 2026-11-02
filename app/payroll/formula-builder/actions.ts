'use server';
import {revalidatePath} from 'next/cache';
import {getTranslations} from 'next-intl/server';
import {getSession} from '@/lib/session';
import {getPayFormula,savePayFormula,testPayFormula,samplePayFormula,setPayFormulaActive,deletePayFormula,saveFormulaAccumulationGroup} from '@/packs/payroll/service';
import {PAY_FORMULA_SAMPLE_VARIABLES,payFormulaSampleFields,type PayFormulaSampleValues} from '@/lib/pay-formula-sample';
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
 return execute(async()=>{const ctx=await getSession();const context={companyId:input.context.companyId,employmentId:input.context.employmentId,period:input.context.period,cycleId:input.context.cycleId,asOf:input.context.asOf,currentCode:input.context.currentCode,input:input.context.input,...(input.context.batchId?{batchId:input.context.batchId}:{})};const test=await testPayFormula(ctx,{id:input.id,revisionId:input.revisionId,context});const formula=await getPayFormula(ctx,input.id);revalidatePath(PAGE);return {test,formula};});
}
/** Sample-value test of the unsaved source: formula catalogue access only; reads no employee data and
 * writes nothing (core samplePayFormula). Only the known sample variables are forwarded. */
export async function sampleFormulaAction(input:{source:string;values:PayFormulaSampleValues}){
 return execute(async()=>{const values:PayFormulaSampleValues={};for(const name of PAY_FORMULA_SAMPLE_VARIABLES){const value=input?.values?.[name];if(typeof value==='string')values[name]=value.slice(0,40);}const source=String(input?.source??'');values.fields={};for(const field of payFormulaSampleFields(source)){const raw=input?.values?.fields?.[field.key];if(typeof raw==='string')values.fields[field.key]=raw.slice(0,501);}return samplePayFormula(await getSession(),{source,values});});
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
export async function searchFormulaEmployeesAction(input:{query:string;companyId:string;period:string;asOf:string}){
 return execute(async()=>{const {searchPayFormulaEmployees}=await import('@/packs/payroll/service');return await searchPayFormulaEmployees(await getSession(),input.query,input.companyId,{period:input.period,asOf:input.asOf});});
}

export async function listFormulaBatchesAction(input:{companyId:string;period:string;cycleId:string}){return execute(async()=>{const {listPayFormulaBatches}=await import('@/packs/payroll/service');return listPayFormulaBatches(await getSession(),input);});}

export async function draftFormulaAction(input:unknown){
 try{const {draftPayFormula}=await import('@/packs/payroll/service');return {ok:true as const,value:await draftPayFormula(await getSession(),input)};}
 catch(error){
  const t=await getTranslations('payFormula.generator');
  const code=error instanceof Error&&error.name==='AiPrivacyGateError'?'reviewRequired':error instanceof Error&&error.message==='not_configured'?'unavailable':'failed';
  return {ok:false as const,error:t(code)};
 }
}
