'use server';
import {getBrowserCommandSession} from '@/lib/session';
import {AiPrivacyGateError} from '@/lib/ai/provider-privacy-request';
import {prepareAssistantImport} from '@/core/assistant-import';
import type {ImportDraft} from '@/lib/assistant-import';
export async function prepareAssistantImportAction(input:unknown):Promise<{ok:true;draft:ImportDraft}|{ok:false;reason?:'protected_input'}>{
 try{return {ok:true,draft:await prepareAssistantImport(await getBrowserCommandSession(),input)};}catch(error){return error instanceof AiPrivacyGateError?{ok:false,reason:'protected_input'}:{ok:false};}
}
