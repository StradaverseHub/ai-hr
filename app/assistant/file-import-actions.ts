'use server';
import {getBrowserCommandSession} from '@/lib/session';
import {prepareAssistantImport} from '@/core/assistant-import';
import type {ImportDraft} from '@/lib/assistant-import';
export async function prepareAssistantImportAction(input:unknown):Promise<{ok:true;draft:ImportDraft}|{ok:false}>{
 try{return {ok:true,draft:await prepareAssistantImport(await getBrowserCommandSession(),input)};}catch{return {ok:false};}
}
