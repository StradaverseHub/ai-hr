import {V9Error,type Case,type Config,type Workflow} from './lifecycle-v9-model';
export type WorkflowPreviewContext={workflowId:string;runId?:string;stepId:string};
/** The authorised caller supplies its loaded case. Never replace an unavailable frozen source with today's definition. */
export function communicationPreviewSource(c:Case,config:Config,context:WorkflowPreviewContext):Workflow{
 const run=context.runId?c.runs.find(run=>run.id===context.runId&&run.workflowId===context.workflowId):undefined;
 if(context.runId&&!run)throw new V9Error('The selected workflow run is unavailable.','not_found');
 const definition=run?run.definition:config.workflows.find(workflow=>workflow.id===context.workflowId);
 if(!definition||definition.module!==c.module)throw new V9Error(run?'The saved workflow definition was not recorded for this run.':'The selected workflow is unavailable.','not_found');
 if(!definition.steps.some(step=>step.id===context.stepId))throw new V9Error('The selected step is not part of this workflow version.','not_found');
 return definition;
}
