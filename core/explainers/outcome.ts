/** ADR-0170 step 4 — the result envelope every explainer and the setup co-pilot return.
 *
 * The refusal vocabulary is core/assistant-tools.ts ToolRefusalCode, so a refusal reads to the model exactly as
 * a production read's does: an ordinary answer ("not on record"), never a fault. Pure. */
import type {ToolRefusalCode} from '../assistant-tools';

export type ExplainerOutcome=Readonly<{ok:true}&Record<string,unknown>>|Readonly<{ok:false;refusal:ToolRefusalCode|'not_permitted';message:string}&Record<string,unknown>>;
export const refuse=(refusal:ToolRefusalCode|'not_permitted',message:string)=>({ok:false as const,refusal,message});
/** The provenance block every explanation carries (core/semantic-model/entities-explain.ts provenanceField). */
export const provenance=(owner:string,ruleVersionSource:string,page:string,note:string)=>Object.freeze({owner,ruleVersionSource,page,note});
