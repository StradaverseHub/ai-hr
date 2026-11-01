'use server';

import {revalidatePath} from 'next/cache';
import {requirePayrollAccess} from '@/lib/authz';
import {previewTaxBasisRecalculation,confirmTaxBasisRecalculation,recoverTaxBasisBatch,continueTaxBasisBatch} from '@/packs/payroll/service';
import {PayrollTaxBasisError,type TaxBasisSelection} from '@/lib/payroll-tax-basis';

export async function previewTaxBasisAction(selection:TaxBasisSelection){
  const ctx=await requirePayrollAccess();
  try{return {ok:true as const,preview:await previewTaxBasisRecalculation(ctx,selection)};}
  catch(error){
    if(!(error instanceof PayrollTaxBasisError))console.error('[tax basis preview]',error);
    return {ok:false as const,error:error instanceof PayrollTaxBasisError?error.message:null};
  }
}

export async function confirmTaxBasisAction(input:{previewId:string;previewHash:string}){
  const ctx=await requirePayrollAccess();
  try{
    const result=await confirmTaxBasisRecalculation(ctx,input);
    revalidatePath('/payroll/income-tax-recalculation');
    revalidatePath('/payroll/income-tax-recalculation/'+result.id);
    return {ok:true as const,result};
  }catch(error){
    if(!(error instanceof PayrollTaxBasisError))console.error('[tax basis confirmation]',error);
    return {ok:false as const,error:error instanceof PayrollTaxBasisError?error.message:null};
  }
}

export async function continueTaxBasisAction(input:{batchId:string}){
  const ctx=await requirePayrollAccess();
  try{
    const result=await continueTaxBasisBatch(ctx,input.batchId);
    revalidatePath('/payroll/income-tax-recalculation');
    revalidatePath('/payroll/income-tax-recalculation/'+result.id);
    return {ok:true as const,result};
  }catch(error){
    if(!(error instanceof PayrollTaxBasisError))console.error('[tax basis continuation]',error);
    return {ok:false as const,error:error instanceof PayrollTaxBasisError?error.message:null};
  }
}

export async function recoverTaxBasisAction(input:{batchId:string}){
  const ctx=await requirePayrollAccess();
  try{
    const result=await recoverTaxBasisBatch(ctx,input.batchId);
    revalidatePath('/payroll/income-tax-recalculation');
    revalidatePath('/payroll/income-tax-recalculation/'+result.id);
    return {ok:true as const,result};
  }catch(error){
    if(!(error instanceof PayrollTaxBasisError))console.error('[tax basis recovery]',error);
    return {ok:false as const,error:error instanceof PayrollTaxBasisError?error.message:null};
  }
}
