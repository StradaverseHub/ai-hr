import type {FormulaProgram} from './pay-formula-language';
export type PayFormulaMethod='write'|'conditions';
export type PayFormulaContext={companyId:string;employmentId:string;period:string;cycleId:string;asOf:string;currentCode:string;input:string};
export type PayFormulaRevision={id:string;ordinal:number;description:string;method:PayFormulaMethod;source:string;program:FormulaProgram;contentHash:string;dependencies:string[];createdAt:string};
export type FormulaReadRequirements={categories:('personnel'|'compensation'|'identity'|'bank'|'statutory'|'confidential_hr')[];fieldIds:string[]};
export type PayFormulaTest={id:string;revisionId:string;passed:boolean;amount:string|null;explanations:string[];error:string|null;context:PayFormulaContext;sourceFingerprint:string;dependencyFingerprint:string;readRequirements:FormulaReadRequirements;createdAt:string};
export type PayFormulaView={id:string;formulaId:string;status:'draft'|'tested'|'active'|'inactive'|'deleted';activeRevisionId:string|null;latest:PayFormulaRevision;versions:PayFormulaRevision[];tests:PayFormulaTest[];usage:{id:string;code:string;name:string}[];idLocked:boolean;updatedAt:string};
export type ActiveFormula={id:string;formulaId:string;revisionId:string;ordinal:number;program:FormulaProgram;contentHash:string;dependencies:string[];evaluatorVersion:string;registryVersion:string;dependencyFingerprint:string};
export class PayFormulaError extends Error{constructor(message:string,public readonly code='FORMULA_INVALID'){super(message);this.name='PayFormulaError';}}
