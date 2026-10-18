import type { InstructionDefinition,PublishedInstruction } from './model';
/** A new authored draft, never a claim about the instructions used by a historical execution. */
export function testingInstructionDraftFrom(source: PublishedInstruction|null): InstructionDefinition {
  if (source?.format===1) return source;
  return { format: 1,title: source?.title??'',objective: '',functionKey: '',area: 'personnel',moduleCode: source?.moduleCode??'',category: 'functional',priority: 'medium',active: true,prerequisites: source?.precondition?[source.precondition]:[],testData: [],steps: source?.steps.map((action,index)=>({id:`step${index+1}`,action,expected:''}))??[{id:'step1',action:'',expected:''}],expectedBehavior: source?.expectedBehavior??'',expectedFunction: source?.expectedFunction??'',permissions: [],jurisdiction: null,configuration: null,screenKeys: [] };
}
