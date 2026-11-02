'use server';
import {getSession} from '@/lib/session';
import {saveContractWorkflow,previewContractWorkflow} from '@/packs/contracts/service';
export async function saveWorkflowAction(input:unknown){const session=await getSession();if(!session)throw new Error('Sign in to continue.');return saveContractWorkflow(session,input);}
export async function previewWorkflowAction(input:unknown){const session=await getSession();if(!session)throw new Error('Sign in to continue.');return previewContractWorkflow(session,input);}
