/**
 * 0db97f14 — the Bank & Statutory import vocabulary. Client-safe (no database imports): the template, the
 * dry run, the merged writer and the history renderer all read the SAME column list, value grammar and
 * "current value" projection from here, so a value the template offers is a value the importer accepts and
 * a value history records is a value revert can compare.
 *
 * Every column's value is a canonical STRING (booleans "yes"/"no", HRDF "yes"/"no"/"default", rates in
 * percent, ringgit to two decimals, choices as their stored code, "" for nothing recorded). The state of one
 * employee is a `BankStatutoryState`: column → that string, projected from the statutory row exactly as the
 * Bank & Statutory tab presents it (EPF Category is DERIVED from the stored mode and figures; income tax
 * residency is the employer-scoped selection the tab shows, "" while it awaits confirmation).
 */
import {PERSONNEL_FIELDS,type PersonnelFieldDescriptor} from './personnel-field-registry';
import {personnelColumnLabel} from './personnel-import-contract';
import {EPF_UI_MODE_OPTIONS,epfUiModeFrom} from './epf-mode-map';
import {PERSONNEL_CHILD_RELIEF_MODES,PERSONNEL_EIS_CATEGORIES,PERSONNEL_EPF_CITIZENSHIPS,PERSONNEL_SOCSO_CATEGORIES,PERSONNEL_TAX_RESIDENCIES} from './personnel-choice-vocabulary';
import {PAYMENT_METHODS} from './payment-methods';
import {clientCountryPacks} from '../localization/registry.client';

export type BankStatutoryState=Record<string,string>;
export type BankStatutoryChoice={value:string;labelKey?:string;label?:string};

const column=(field:PersonnelFieldDescriptor)=>field.import.column!;
/** Columns written through the merged statutory writer (the full-row, tax and Others Statutory setters). */
export const STATUTORY_WRITER_FIELDS:readonly PersonnelFieldDescriptor[]=PERSONNEL_FIELDS.filter(field=>field.import.writer==='statutory'&&field.import.column);
export const BANK_COLUMNS:readonly string[]=PERSONNEL_FIELDS.filter(field=>field.import.writer==='bank').map(column);
export const REGISTRATION_COLUMNS=['epf_number','socso_number'] as const;
export const TAX_COLUMNS=['tax_number','tax_category','tax_circumstance','tax_residency','disabled_individual','disabled_spouse','child_relief_mode','num_children','employer_bears_tax'] as const;
export const CHILD_RELIEF_GRID_FIELDS=STATUTORY_WRITER_FIELDS.filter(field=>field.childReliefCell);
export const CHILD_RELIEF_GRID_COLUMNS:readonly string[]=CHILD_RELIEF_GRID_FIELDS.map(column);
export const STATUTORY_ROW_COLUMNS=['epf_citizenship','epf_category','epf_employee_rate','epf_employer_rate','epf_employee_amount','epf_employer_amount','epf_manual_reason','employer_bears_epf','socso_category','eis_category','subject_to_skbbk','employer_bears_socso','employer_bears_eis','employer_bears_skbbk'] as const;
export const OTHERS_COLUMNS=['subject_to_hrdf'] as const;
/** Every column whose value is recorded in import history and compared by revert, in tab order. */
export const BANK_STATUTORY_STATE_COLUMNS:readonly string[]=[...BANK_COLUMNS,...REGISTRATION_COLUMNS,...STATUTORY_ROW_COLUMNS,...OTHERS_COLUMNS,...TAX_COLUMNS,...CHILD_RELIEF_GRID_COLUMNS,'payment_method'];
const taxColumns=new Set<string>([...TAX_COLUMNS,...CHILD_RELIEF_GRID_COLUMNS]);
export const isTaxColumn=(c:string)=>taxColumns.has(c);
/** Columns parsed by this module (bank, registration and payment method keep their established parsers). */
export const MERGED_STATUTORY_COLUMNS:readonly string[]=[...STATUTORY_ROW_COLUMNS,...OTHERS_COLUMNS,...TAX_COLUMNS,...CHILD_RELIEF_GRID_COLUMNS];

const YES_NO:BankStatutoryChoice[]=[{value:'yes',labelKey:'people.import.choiceYes'},{value:'no',labelKey:'people.import.choiceNo'}];
const BOOLEAN_COLUMNS=new Set<string>([...PERSONNEL_FIELDS.filter(field=>field.import.section==='bank_statutory'&&field.import.column&&field.type==='boolean'&&['bank','statutory'].includes(field.import.writer??'')).map(column),'eis_eligible','is_resident']);
export const isBankStatutoryBoolean=(c:string)=>BOOLEAN_COLUMNS.has(c);
const CITIZENSHIP_KEYS={citizen:'epfCitizenshipCitizen',pr:'epfCitizenshipPr',non_citizen:'epfCitizenshipNonCitizen'} as const;
const RELIEF_MODE_KEYS={manual:'childReliefModeManual',auto:'childReliefModeAuto',auto_table:'childReliefModeAutoTable'} as const;
const RESIDENCY_KEYS={resident:'taxResidencyResident',non_resident:'taxResidencyNonResident',rep:'taxResidencyRep',knowledge_worker:'taxResidencyKnowledgeWorker',c_suite:'taxResidencyCSuite'} as const;
const capital=(v:string)=>v[0].toUpperCase()+v.slice(1);
/** Tax circumstance and bank names come from the country packs (MY only today), never a second list. */
function packTaxCircumstances():BankStatutoryChoice[]{
 const seen=new Map<string,BankStatutoryChoice>();
 for(const pack of clientCountryPacks())for(const option of pack.payroll.taxCircumstanceOptions??[])if(!seen.has(option.value))seen.set(option.value,{value:option.value,labelKey:`people.detail.${option.key}`});
 return [...seen.values()];
}
function packBankNames():BankStatutoryChoice[]{return [...new Set(clientCountryPacks().flatMap(pack=>pack.bankNames??[]))].map(value=>({value,label:value}));}
/** The closed vocabulary of a column, or [] for free text and numbers. */
export function bankStatutoryChoices(c:string):BankStatutoryChoice[]{
 if(BOOLEAN_COLUMNS.has(c))return YES_NO;
 switch(c){
  case 'subject_to_hrdf':return [...YES_NO,{value:'default',labelKey:'people.import.choiceHrdfDefault'}];
  case 'epf_citizenship':return PERSONNEL_EPF_CITIZENSHIPS.map(value=>({value,labelKey:`people.detail.${CITIZENSHIP_KEYS[value]}`}));
  case 'epf_category':return EPF_UI_MODE_OPTIONS.map(option=>({value:option.value,labelKey:option.labelKey}));
  case 'socso_category':return PERSONNEL_SOCSO_CATEGORIES.map(value=>({value,labelKey:`people.detail.socsoCategory${capital(value)}`}));
  case 'eis_category':return PERSONNEL_EIS_CATEGORIES.map(value=>({value,labelKey:`people.detail.eisCategory${capital(value)}`}));
  case 'child_relief_mode':return PERSONNEL_CHILD_RELIEF_MODES.map(value=>({value,labelKey:`people.detail.${RELIEF_MODE_KEYS[value]}`}));
  case 'tax_residency':return PERSONNEL_TAX_RESIDENCIES.map(value=>({value,labelKey:`people.detail.${RESIDENCY_KEYS[value]}`}));
  case 'tax_circumstance':return packTaxCircumstances();
  case 'tax_category':return ['1','2','3'].map(value=>({value,label:value}));
  case 'bank_name':return packBankNames();
  default:return [];
 }
}
/** Bank name is a suggestion list only: a bank already on file under another spelling stays accepted. */
const strictChoice=(c:string)=>c!=='bank_name'&&bankStatutoryChoices(c).length>0;

/** English column caption for row errors (the screen translates its own chrome). */
export const bankStatutoryColumnLabel=(c:string)=>personnelColumnLabel(c,'employee');
const RATE=new Set(['epf_employee_rate','epf_employer_rate']),AMOUNT=new Set(['epf_employee_amount','epf_employer_amount']),WHOLE=new Set(['num_children',...CHILD_RELIEF_GRID_COLUMNS]);
const TRUE=new Set(['yes','y','true','1']),FALSE=new Set(['no','n','false','0']);
const token=(raw:string)=>raw.trim().toLowerCase().replace(/[\s-]+/g,'_');
export const formatPercent=(n:number)=>String(Number(n.toFixed(4)));
export const formatAmount=(n:number)=>n.toFixed(2);

/** One non-blank cell → its canonical value, or the reason it is refused (column caption first). */
export function parseBankStatutoryCell(c:string,raw:string):{value:string;error?:undefined}|{error:string;value?:undefined}{
 const text=raw.trim(),caption=bankStatutoryColumnLabel(c);
 if(BOOLEAN_COLUMNS.has(c)){const v=text.toLowerCase();if(TRUE.has(v))return{value:'yes'};if(FALSE.has(v))return{value:'no'};return{error:`${caption}: use Yes or No`};}
 if(c==='subject_to_hrdf'){const v=token(text);if(TRUE.has(v))return{value:'yes'};if(FALSE.has(v))return{value:'no'};if(['default','company_default'].includes(v))return{value:'default'};return{error:`${caption}: use Yes, No or Default (follow the company's HRDF registration)`};}
 if(c==='tax_category'){const n=Number(text);return[1,2,3].includes(n)?{value:String(n)}:{error:`${caption}: use 1, 2 or 3`};}
 if(RATE.has(c)){const n=Number(text.replace(/%$/,''));return text!==''&&Number.isFinite(n)&&n>=0&&n<=100&&Math.abs(Math.round(n*100)-n*100)<1e-9?{value:formatPercent(n)}:{error:`${caption}: enter a percentage between 0 and 100 (up to 2 decimals)`};}
 if(AMOUNT.has(c)){const n=Number(text.replace(/[,_]/g,''));return text!==''&&Number.isFinite(n)&&n>=0?{value:formatAmount(n)}:{error:`${caption}: enter an amount of 0 or more in RM`};}
 if(WHOLE.has(c)){const n=Number(text.replace(/[,_]/g,''));return text!==''&&Number.isSafeInteger(n)&&n>=0?{value:String(n)}:{error:`${caption}: enter a whole number of 0 or more`};}
 if(strictChoice(c)){
  const choices=bankStatutoryChoices(c),v=token(text);
  const hit=choices.find(choice=>token(choice.value)===v);
  return hit?{value:hit.value}:{error:`${caption}: use one of ${choices.map(choice=>choice.value).join(', ')}`};
 }
 return{value:text};
}

const yn=(v:unknown)=>v?'yes':'no';
const str=(v:unknown)=>v==null?'':String(v);
const num=(v:unknown)=>v==null||v===''?null:Number(v);
type GridCell={full?:number;half?:number};
/** The tab's view of one employee's statutory row (null when the employee has no statutory row yet). */
export function bankStatutoryStateFrom(row:Record<string,unknown>|null,extra:{taxResidency:string;paymentMethod:string|null}):BankStatutoryState{
 const s=row??{};const state:BankStatutoryState={};
 state.bank_name=str(s.bankName);state.bank_account_no=str(s.bankAccountNo);
 state.enable_custom_holder_name=yn(s.enableCustomHolderName);state.custom_holder_name=str(s.customHolderName);
 state.enable_custom_holder_id=yn(s.enableCustomHolderId);state.custom_holder_id=str(s.customHolderId);
 state.epf_number=str(s.epfNumber);state.socso_number=str(s.socsoNumber);
 state.epf_citizenship=str(s.epfCitizenship??(row?'citizen':''));
 const er=num(s.epfEmployeeRate),rr=num(s.epfEmployerRate),ea=num(s.epfEmployeeAmount),ra=num(s.epfEmployerAmount);
 state.epf_category=row?epfUiModeFrom(str(s.epfMode)||null,er,rr,ea,ra):'';
 state.epf_employee_rate=er==null?'':formatPercent(er*100);state.epf_employer_rate=rr==null?'':formatPercent(rr*100);
 state.epf_employee_amount=ea==null?'':formatAmount(ea);state.epf_employer_amount=ra==null?'':formatAmount(ra);
 state.epf_manual_reason=str(s.epfManualReason);
 for(const [c,k] of [['employer_bears_epf','employerBearsEpf'],['subject_to_skbbk','subjectToSkbbk'],['employer_bears_socso','employerBearsSocso'],['employer_bears_eis','employerBearsEis'],['employer_bears_skbbk','employerBearsSkbbk'],['disabled_individual','disabledIndividual'],['disabled_spouse','disabledSpouse'],['employer_bears_tax','employerBearsTax']] as const)state[c]=yn(s[k]);
 state.socso_category=str(s.socsoCategory??(row?'auto':''));state.eis_category=str(s.eisCategory??(row?'auto':''));
 state.subject_to_hrdf=s.subjectToHrdf===true?'yes':s.subjectToHrdf===false?'no':'default';
 state.tax_number=str(s.taxNumber);state.tax_category=row?str(s.taxCategory??1):'';state.tax_circumstance=str(s.taxCircumstance);
 state.tax_residency=extra.taxResidency;state.num_children=row?str(s.numChildren??0):'';state.child_relief_mode=str(s.childReliefMode??(row?'manual':''));
 const grid=(s.childReliefTable&&typeof s.childReliefTable==='object'?s.childReliefTable:{}) as Record<string,GridCell>;
 for(const field of CHILD_RELIEF_GRID_FIELDS){const cell=field.childReliefCell!;state[column(field)]=String(Number(grid[cell.category]?.[cell.share]??0)||0);}
 state.payment_method=str(extra.paymentMethod);
 return state;
}
/** The child-relief grid of a state, in the shape the tax setter validates. */
export function childReliefTableFrom(state:BankStatutoryState){
 const out:Record<string,{full:number;half:number}>={};
 for(const field of CHILD_RELIEF_GRID_FIELDS){const cell=field.childReliefCell!;out[cell.category]??={full:0,half:0};out[cell.category][cell.share]=Number(state[column(field)]||0);}
 return out;
}
/** Item before/after in import history: only the columns this import changed, as canonical strings.
 *  b6dbadc5 — `epfTopupBasis` says what a recorded Top-up rate MEANS: 'additive' (an increment, recorded
 *  since b6dbadc5 from a row that was not a legacy total-rate top-up) or 'total' (a pre-additive full rate).
 *  Absent = recorded before b6dbadc5, i.e. a full rate. Revert refuses to restore a non-additive Top-up rate. */
export type BankStatutoryItemState={employeeCode:string;fields:Record<string,string>;epfTopupBasis?:'additive'|'total'};
/** b6dbadc5 — the basis recorded with an import item's "before" state, from the statutory row it was read from. */
export function bankStatutoryTopupBasis(row:{epfMode?:string|null;epfEmployerRate?:string|number|null}|null|undefined):'additive'|'total'{
 return row?.epfMode==='voluntary_excess'&&row.epfEmployerRate!=null?'total':'additive';
}
/** b6dbadc5 — an import item's "before" state. The Top-up basis is recorded only when the item changed the EPF
 *  election (category or a rate), the only case revert reads it; other items keep their pre-b6dbadc5 shape.
 *  NOT WIRED YET: the import writers live in core/import-sections.ts, which must stay byte-identical to the
 *  installed Bank import worker source (test/ai-review-worker-compatibility.test.ts). Until that file may
 *  change, items carry no basis, so revert refuses any import that changed a Top-up rate — fail-closed. */
export function bankStatutoryBeforeState(employeeCode:string,fields:Record<string,string>,row:Parameters<typeof bankStatutoryTopupBasis>[0]):BankStatutoryItemState{
 return ['epf_category','epf_employee_rate','epf_employer_rate'].some(c=>c in fields)?{employeeCode,fields,epfTopupBasis:bankStatutoryTopupBasis(row)}:{employeeCode,fields};
}
