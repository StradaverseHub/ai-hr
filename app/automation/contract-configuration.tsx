import type {SessionContext} from '@/db/client';
import {contractConfigurationWorkflows,contractConfigurationTemplates} from '@/packs/contracts/service';
import {ContractWorkflowEditor} from '@/app/lifecycle/contracts/workflows/editor';
import {ContractTemplatesEditor} from '@/app/lifecycle/contracts/templates/editor';
import {templateLabels} from '@/app/letters/templates/labels';
import {searchContractReviewersAction} from '@/app/lifecycle/contracts/workflows/actions';
/** Existing Contract owner editors are hosted here; publishing, preview and approval keep their original services. */
export async function ContractWorkflowSection({ctx}:{ctx:SessionContext}){
 const workspace=await contractConfigurationWorkflows(ctx);
 return <section aria-label="Contract staff workflows"><ContractWorkflowEditor embedded {...workspace} directories={[]} loadDirectory={searchContractReviewersAction}/></section>;
}
export async function ContractTemplateSection({ctx}:{ctx:SessionContext}){
 const [workspace,labels]=await Promise.all([contractConfigurationTemplates(ctx),templateLabels()]);
 return <section aria-label="Contract staff templates"><ContractTemplatesEditor embedded templates={workspace.templates} companies={workspace.companies} editorLabels={labels.editor}/></section>;
}
