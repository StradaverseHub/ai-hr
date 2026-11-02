'use server';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {saveContractWorkflow,previewContractWorkflow} from '@/packs/contracts/service';
export async function saveWorkflowAction(input:unknown){const session=await requireScopedLifecycleModule();if(!session)throw new Error('Sign in to continue.');return saveContractWorkflow(session,input);}
export async function previewWorkflowAction(input:unknown){const session=await requireScopedLifecycleModule();if(!session)throw new Error('Sign in to continue.');return previewContractWorkflow(session,input);}
