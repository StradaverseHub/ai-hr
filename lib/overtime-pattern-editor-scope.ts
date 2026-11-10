/** Board item b31981c0 (phase 1 simplification of Attendance > Settings > Overtime Patterns).
 *
 * The editor now exposes only the pattern label, name, description and eligibility (day types on General
 * Settings plus the Eligibility step). Owning/applicable companies, currency and its precision, the eligibility
 * evaluation scope, the payable-count allocation, rates and every advanced calculation field are no longer on
 * screen, but the evaluator, policy binding, Payroll and TOIL readers still use them for patterns that already
 * exist. So the server never takes them from the browser: an existing draft keeps exactly its saved values, and a
 * new draft gets the defaults the screen already suggested (once per attendance day, earliest recorded work).
 *
 * Pure and DB-free so the server action and its tests share one rule. It never calculates money. */
import type {OvertimePattern} from './overtime-pattern-model';
import {overtimeObject,overtimeRefuse} from './overtime-pattern-schema';
import {currencyMinorScale} from './currencies';
import {prepareOvertimeStarter,readOvertimeStarterSeed,type OvertimeStarterKey} from './overtime-pattern-starters';

/** The single definition field the simplified editor may change. */
export const OVERTIME_EDITOR_DEFINITION_FIELDS=['eligibility'] as const;
/** Existing editor defaults for a new draft. ADR-0123 amendment: a future activation path must re-establish an
 * explicit choice (or an owner decision) before a draft carrying these defaults can be activated. */
export const OVERTIME_EDITOR_DEFAULT_BASIS:OvertimePattern['eligibilityBasis']='day';
export const OVERTIME_EDITOR_DEFAULT_ALLOCATION:OvertimePattern['durationAllocation']='earliest';

export function blankOvertimePattern(currency:OvertimePattern['currency']={code:'',minorScale:0}):OvertimePattern {
 return {v:1,currency,eligibilityBasis:OVERTIME_EDITOR_DEFAULT_BASIS,durationAllocation:OVERTIME_EDITOR_DEFAULT_ALLOCATION,definitions:[],
  eligibility:{id:'eligibility',type:'group',logic:'and',children:[]},eligibleMinutes:null,durationCap:null,durationRounding:null,
  deductions:[],rates:[],paymentCap:null,moneyRounding:{stage:'line',mode:'halfUp'}};
}

/** Canonical currency for a company currency code, or a blank one when the code is unavailable. */
export function overtimeEditorCurrency(code:string|null|undefined):OvertimePattern['currency'] {
 if(!code)return {code:'',minorScale:0};
 try {return {code,minorScale:currencyMinorScale(code)};} catch {return {code:'',minorScale:0};}
}

/** Where hidden values come from: the saved definition (a saved starter seed expands to its prepared draft),
 * or for a new pattern the chosen starter / an empty custom draft. Never the browser. */
export function overtimeEditorBase(saved:unknown,starterKey?:OvertimeStarterKey|null):unknown {
 if(saved===null||saved===undefined)return starterKey?prepareOvertimeStarter(starterKey,OVERTIME_EDITOR_DEFAULT_BASIS,OVERTIME_EDITOR_DEFAULT_ALLOCATION):blankOvertimePattern();
 const seed=readOvertimeStarterSeed(saved);
 return seed?prepareOvertimeStarter(seed,OVERTIME_EDITOR_DEFAULT_BASIS,OVERTIME_EDITOR_DEFAULT_ALLOCATION):saved;
}

/** Combine the server-owned base with the only browser-editable definition field. A blank currency is filled
 * from the owning company's currency; a non-blank saved currency is never overwritten. The result is still
 * validated by the pack's draft owner before it is stored. */
export function overtimeEditorDefinition(base:unknown,posted:unknown,companyCurrency:string|null|undefined):Record<string,unknown> {
 const saved=overtimeObject(base,'pattern'),browser=overtimeObject(posted,'pattern');
 if(!('eligibility' in browser))overtimeRefuse('invalid','eligibility','Choose who this pattern applies to.');
 const next:Record<string,unknown>={...saved,eligibility:browser.eligibility};
 const currency=saved.currency as {code?:unknown}|undefined;
 if(!currency||typeof currency!=='object'||currency.code===''||currency.code===undefined)next.currency=overtimeEditorCurrency(companyCurrency);
 return next;
}
