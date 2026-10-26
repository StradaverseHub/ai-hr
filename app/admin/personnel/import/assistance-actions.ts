'use server';
import {getBrowserCommandSession} from '@/lib/session';
import {assistPersonnelImportHeaders,PERSONNEL_IMPORT_ASSISTANCE_UNAVAILABLE} from '@/core/personnel-import-assistance';
import type {PersonnelImportHeaderAssistanceResult} from '@/lib/personnel-import-assistance';
/** Explicit header-only command. Cookie-only session; DEV_USER_ID is never browser authority. */
export async function assistPersonnelImportHeadersAction(value:unknown):Promise<PersonnelImportHeaderAssistanceResult>{
 try{const ctx=await getBrowserCommandSession();return await assistPersonnelImportHeaders(ctx,value);}
 catch{return{kind:'unavailable',message:PERSONNEL_IMPORT_ASSISTANCE_UNAVAILABLE};}
}
