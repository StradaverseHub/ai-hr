'use server';
import {getSession} from '@/lib/session';
import {saveContractTemplate,publishContractTemplate,exportContractTemplateLibrary} from '@/packs/contracts/service';
export async function saveTemplateAction(input:unknown){const s=await getSession();if(!s)throw new Error('Sign in to continue.');return saveContractTemplate(s,input);}
export async function publishTemplateAction(input:unknown){const s=await getSession();if(!s)throw new Error('Sign in to continue.');return publishContractTemplate(s,input);}
export async function exportTemplatesAction(){const s=await getSession();if(!s)throw new Error('Sign in to continue.');return exportContractTemplateLibrary(s);}
