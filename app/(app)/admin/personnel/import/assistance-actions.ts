'use server';
import {getBrowserCommandSession} from '@/lib/session';
import {preparePersonnelImportHeaders,assistPersonnelImportHeaders,reopenPersonnelImportHeaders,PERSONNEL_IMPORT_ASSISTANCE_UNAVAILABLE} from '@/core/personnel-import-assistance';
import type {PersonnelImportHeaderAssistanceResult,PersonnelImportHeaderPreparationResult} from '@/lib/personnel-import-assistance';
/** Explicit NEW preparation. Cookie-only session; never provider/admission/effect access. */
export async function preparePersonnelImportHeadersAction(value:unknown):Promise<PersonnelImportHeaderPreparationResult>{
 try{return await preparePersonnelImportHeaders(await getBrowserCommandSession(),value);}catch{return{kind:'unavailable',message:PERSONNEL_IMPORT_ASSISTANCE_UNAVAILABLE};}
}
/** Existing server-issued identity only; DEV_USER_ID is never browser authority. */
export async function assistPersonnelImportHeadersAction(value:unknown):Promise<PersonnelImportHeaderAssistanceResult>{
 try{return await assistPersonnelImportHeaders(await getBrowserCommandSession(),value);}catch{return{kind:'unavailable',message:PERSONNEL_IMPORT_ASSISTANCE_UNAVAILABLE};}
}
/** Strict recovery: existing completed receipt only. Never creates, admits or dispatches. */
export async function reopenPersonnelImportHeadersAction(value:unknown):Promise<PersonnelImportHeaderAssistanceResult>{
 try{return await reopenPersonnelImportHeaders(await getBrowserCommandSession(),value);}catch{return{kind:'unavailable',message:PERSONNEL_IMPORT_ASSISTANCE_UNAVAILABLE};}
}
