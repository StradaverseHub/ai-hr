'use server';
import {WorkforceAccessError} from '@/core/workforce-access';
import {CostAllocationError} from '@/lib/employment-cost-allocation';
import {getSession} from '@/lib/session';
import {revalidatePath} from 'next/cache';
import {parseCostAllocationCsv} from '@/lib/cost-allocation-import';
import {commitCostAllocationImport,previewCostAllocationImport,costAllocationReferences,costAllocationWorkbookReferences} from '@/core/cost-allocation-import';
export async function allocationImportReferencesAction(companyId:string){return costAllocationReferences(await getSession(),companyId);}
export async function previewAllocationImportAction(csv:string){return previewCostAllocationImport(await getSession(),parseCostAllocationCsv(csv));}
export async function commitAllocationImportAction(csv:string,token:string){const result=await commitCostAllocationImport(await getSession(),parseCostAllocationCsv(csv),token);revalidatePath('/admin/personnel','layout');return result;}

export async function allocationWorkbookReferencesAction(companyIds:string[],selectedCompanyId:string){try{return{ok:true as const,rows:await costAllocationWorkbookReferences(await getSession(),companyIds,selectedCompanyId)};}catch(e){return{ok:false as const,error:e instanceof WorkforceAccessError||e instanceof CostAllocationError&&e.code==='scope'?'scope' as const:'invalid' as const};}}
