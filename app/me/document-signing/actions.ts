'use server';
import {revalidatePath} from 'next/cache';
import {requireModule} from '@/lib/authz';
import {v9DocumentRouteAct,v9DocumentRouteEdit,v9ReadDocumentSigningWork,type V9DocumentRouteAction} from '@/packs/lifecycle/service';
async function execute<T>(work:()=>Promise<T>){try{const item=await work();for(const path of ['/me/document-signing','/me/lifecycle','/tasks','/lifecycle/v9','/lifecycle/onboarding'])revalidatePath(path);return{ok:true as const,item};}catch{return{ok:false as const,error:'The document changed or this action is unavailable. Refresh and check your assigned step.'};}}
export async function actOnRoutedDocument(input:V9DocumentRouteAction){return execute(async()=>v9DocumentRouteAct(await requireModule('lifecycle'),input));}
export async function editRoutedDocument(input:{caseId:string;caseRevision:number;documentId:string;edits?:Record<string,string>;values?:Record<string,string>}){return execute(async()=>v9DocumentRouteEdit(await requireModule('lifecycle'),input));}
export async function refreshRoutedDocument(caseId:string,documentId:string){return execute(async()=>v9ReadDocumentSigningWork(await requireModule('lifecycle'),caseId,documentId));}
