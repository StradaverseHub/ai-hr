import type {FormulaProgram} from './pay-formula-language';
export type PayFormulaMethod='write'|'conditions';
export type PayFormulaContext={companyId:string;employmentId:string;period:string;cycleId:string;asOf:string;currentCode:string;input:string;batchId?:string};
export type PayFormulaRevision={id:string;ordinal:number;description:string;method:PayFormulaMethod;source:string;program:FormulaProgram;contentHash:string;dependencies:string[];dependencySnapshot?:unknown;createdAt:string};
export type FormulaReadRequirements={categories:('personnel'|'compensation'|'identity'|'bank'|'statutory'|'confidential_hr')[];fieldIds:string[];workforce?:boolean};
/** Owner decision 13 Nov 2026: a Pay Item the employee does not have in this run counts as 0. Each such read is
 * recorded so a test receipt and a payroll trace can say so. `group` names the Accumulation group of a member. */
export type PayFormulaMissingItem={source:'PayItem'|'PayItemNoProrate'|'PayItemInput'|'Accumulation';code:string;group?:string};
export type PayFormulaTest={id:string;revisionId:string;passed:boolean;amount:string|null;explanations:string[];error:string|null;context:PayFormulaContext;sourceFingerprint:string;dependencyFingerprint:string;readRequirements:FormulaReadRequirements;createdAt:string;missingItems?:PayFormulaMissingItem[]};
export type PayFormulaCapabilities={view:boolean;edit:boolean;test:boolean;activate:boolean;deactivate:boolean;delete:boolean};
export type PayFormulaEvaluationSummary={companyName:string|null;employeeCode:string|null;employeeName:string|null;id:string;revisionId:string;componentCode:string;period:string;amount:string;createdAt:string};
export type PayFormulaEvaluationDetail=PayFormulaEvaluationSummary&{formulaId:string;ordinal:number;contentHash:string;batchId:string;companyId:string;employmentId:string;payload:{explanations:string[];reads:import('./pay-formula-language').FormulaEvaluation['reads'];sources?:unknown;missingItems?:PayFormulaMissingItem[]}};
export type PayFormulaView={id:string;formulaId:string;status:'draft'|'tested'|'active'|'inactive'|'deleted';activeRevisionId:string|null;latest:PayFormulaRevision;versions:PayFormulaRevision[];tests:PayFormulaTest[];usage:{id:string;code:string;name:string}[];idLocked:boolean;updatedAt:string;capabilities:PayFormulaCapabilities;evaluations?:PayFormulaEvaluationSummary[]};
export type ActiveFormula={id:string;formulaId:string;revisionId:string;ordinal:number;program:FormulaProgram;contentHash:string;dependencies:string[];evaluatorVersion:string;registryVersion:string;dependencyFingerprint:string};
export class PayFormulaError extends Error{constructor(message:string,public readonly code='FORMULA_INVALID'){super(message);this.name='PayFormulaError';}}
