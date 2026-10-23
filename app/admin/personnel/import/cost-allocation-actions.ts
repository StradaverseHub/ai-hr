'use server';
import {getSession} from '@/lib/session';
import {revalidatePath} from 'next/cache';
import {parseCostAllocationCsv} from '@/lib/cost-allocation-import';
import {commitCostAllocationImport,previewCostAllocationImport,costAllocationReferences} from '@/core/cost-allocation-import';
export async function allocationImportReferencesAction(companyId:string){return costAllocationReferences(await getSession(),companyId);}
export async function previewAllocationImportAction(csv:string){return previewCostAllocationImport(await getSession(),parseCostAllocationCsv(csv));}
export async function commitAllocationImportAction(csv:string,token:string){const result=await commitCostAllocationImport(await getSession(),parseCostAllocationCsv(csv),token);revalidatePath('/admin/personnel','layout');return result;}
