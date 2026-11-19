'use server';
import {getTranslations} from 'next-intl/server';
import {revalidatePath} from 'next/cache';
import {requireModule} from '@/lib/authz';
import {v9SubmitOwnDocumentCompletion,v9DocumentRouteAct,v9DocumentRouteEdit,v9ReadDocumentSigningWork,type V9DocumentRouteAction} from '@/packs/lifecycle/service';
async function execute<T>(work:()=>Promise<T>){try{const item=await work();for(const path of ['/me/document-signing','/me/lifecycle','/tasks','/lifecycle/v9','/lifecycle/onboarding'])revalidatePath(path);return{ok:true as const,item};}catch{return{ok:false as const,error:'The document changed or this action is unavailable. Refresh and check your assigned step.'};}}
export async function actOnRoutedDocument(input:V9DocumentRouteAction){return execute(async()=>v9DocumentRouteAct(await requireModule('lifecycle'),input));}
export async function editRoutedDocument(input:{caseId:string;caseRevision:number;documentId:string;edits?:Record<string,string>;values?:Record<string,string>}){return execute(async()=>v9DocumentRouteEdit(await requireModule('lifecycle'),input));}
export async function refreshRoutedDocument(caseId:string,documentId:string){return execute(async()=>v9ReadDocumentSigningWork(await requireModule('lifecycle'),caseId,documentId));}

export async function submitRoutedDocumentCompletion(input:{caseId:string;revision:number;documentId:string;values:Record<string,string>}){
 try{const session=await requireModule('lifecycle');await v9SubmitOwnDocumentCompletion(session,input);const item=await v9ReadDocumentSigningWork(session,input.caseId,input.documentId);for(const path of ['/me/document-signing','/me/lifecycle','/tasks','/lifecycle/v9','/lifecycle/onboarding'])revalidatePath(path);return{ok:true as const,item};}
 catch{const t=await getTranslations('personnelCompletion');return{ok:false as const,error:t('saveFailed')};}
}
