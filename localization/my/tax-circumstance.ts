/** Person-owned circumstance. Category integers remain LHDN's existing mathematical inputs. */
export const TAX_CIRCUMSTANCES = ['single','spouse_not_working','spouse_working','widow_divorced','none'] as const;
export type TaxCircumstance = typeof TAX_CIRCUMSTANCES[number];
export const taxCircumstanceOk = (value: unknown): value is TaxCircumstance => typeof value === 'string' && (TAX_CIRCUMSTANCES as readonly string[]).includes(value);
export const TAX_CIRCUMSTANCE_OPTIONS = [
 {value:'single',category:1,key:'taxCategorySingle'},
 {value:'spouse_not_working',category:2,key:'taxCategoryMarriedSpouseNotWorking'},
 {value:'spouse_working',category:3,key:'taxCategoryMarriedSpouseWorking'},
 {value:'widow_divorced',category:3,key:'taxCategoryDivorcedWithKids'},
 {value:'none',category:null,key:'taxCategoryNone'},
] as const;
export function taxCircumstanceOf(key:unknown,category:unknown){
 const choice=TAX_CIRCUMSTANCE_OPTIONS.find(x=>x.value===key);
 const integer=[1,2,3].includes(Number(category))?Number(category):1;
 if(choice && choice.category!==null && choice.category!==integer)throw new Error('Tax circumstance and category disagree');
 return {key:choice?.value??null,category:choice?.category??integer,applicable:choice?.value!=='none',labelKey:choice?.key??(integer===3?'taxCategoryLegacy3':integer===2?'taxCategoryMarriedSpouseNotWorking':'taxCategorySingle')};
}
/** Omitted identity preserves compatible saved detail; a deliberate conflicting numeric edit retires it. */
export function writeTaxCircumstance(p:{key?:unknown;category?:number;beforeKey?:unknown;beforeCategory?:number;epoch?:number}){
 if(p.key!==undefined&&p.key!==null&&!taxCircumstanceOk(p.key))throw new Error('Invalid tax circumstance');
 const category=[1,2,3].includes(Number(p.category))?Number(p.category):p.beforeCategory??1;
 let key=p.key===undefined?p.beforeKey??null:p.key;
 if(p.key===undefined&&key!=='none'&&taxCircumstanceOk(key)&&TAX_CIRCUMSTANCE_OPTIONS.find(x=>x.value===key)?.category!==category)key=null;
 // Resolve explicit choices against their fixed integer, without altering a dormant integer on None.
 const option=TAX_CIRCUMSTANCE_OPTIONS.find(x=>x.value===key);
 const mapped=key==='none'?p.beforeCategory??category:option?.category??category;
 const beforeNone=p.beforeKey==='none',afterNone=key==='none';
 return {taxCategory:mapped,taxCircumstance:taxCircumstanceOk(key)?key:null,taxApplicabilityEpoch:(p.epoch??0)+(beforeNone!==afterNone?1:0)};
}
export type SavedTaxCircumstance={version:1;key:TaxCircumstance|null;category:1|2|3|null;applicable:boolean;epoch:number};
export function savedTaxCircumstance(key:unknown,category:unknown,epoch=0):SavedTaxCircumstance{
 const resolved=taxCircumstanceOf(key,category);
 return {version:1,key:resolved.key,category:resolved.applicable?resolved.category as 1|2|3:null,applicable:resolved.applicable,epoch};
}
export function readSavedTaxCircumstance(value:unknown):SavedTaxCircumstance|null{
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const p=value as SavedTaxCircumstance;
 if(p.version!==1||!Number.isSafeInteger(p.epoch)||p.epoch<0||p.key!==null&&!taxCircumstanceOk(p.key))return null;
 if(p.key==='none')return p.applicable===false&&p.category===null?p:null;
 if(p.applicable!==true||![1,2,3].includes(Number(p.category)))return null;
 try{return taxCircumstanceOf(p.key,p.category).category===p.category?p:null}catch{return null}
}
