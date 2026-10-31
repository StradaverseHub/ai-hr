'use server';
import {revalidatePath} from 'next/cache';
import {getSession} from '@/lib/session';
import {getEmploymentCostAllocations,previewEmploymentCostAllocations,saveEmploymentCostAllocations,CostAllocationError} from '@/core/employment-cost-allocations';
export async function readCostAllocationsAction(employmentId:string,date:string){return getEmploymentCostAllocations(await getSession(),employmentId,date);}
export async function previewCostAllocationsAction(input:unknown){try{return{ok:true as const,value:await previewEmploymentCostAllocations(await getSession(),input)};}catch(e){return{ok:false as const,error:e instanceof CostAllocationError?e.code:'invalid'};}}
export async function saveCostAllocationsAction(input:unknown,digest:string){try{await saveEmploymentCostAllocations(await getSession(),input,{digest});revalidatePath('/admin/personnel','layout');return{ok:true as const};}catch(e){return{ok:false as const,error:e instanceof CostAllocationError?e.code:'invalid'};}}
