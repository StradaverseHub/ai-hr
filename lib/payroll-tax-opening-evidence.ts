/** Historical evidence resolution only. Never reads today's editable TP3 or infers a zero. */
export type TaxOpeningSource={id:string;sourceHash:string;statutory:Record<string,unknown>};
export type TaxOpeningEvidence={state:'known';used:Record<string,number>;sourceIds:string[]}|{state:'missing'|'conflict';reason:string};
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const canonical=(v:Record<string,number>)=>JSON.stringify(Object.entries(v).filter(([,amount])=>amount>0).sort(([a],[b])=>a.localeCompare(b)));
export function resolveTaxOpeningEvidence(input:{year:number;employmentId:string;companyId:string;required:boolean;requiredSourceIds?:string[];sources:TaxOpeningSource[]}):TaxOpeningEvidence{
 if(!input.required)return{state:'known',used:{},sourceIds:[]};
 const candidates:{id:string;used:Record<string,number>}[]=[];
 const required=input.requiredSourceIds?new Set(input.requiredSourceIds):null;
 const lacking=input.sources.filter(source=>(!required||required.has(source.id))&&(!object(source.statutory.taxBasisOpeningExemptionUsed)||source.statutory.taxBasisOpeningExemptionYear!==input.year));
 for(const source of input.sources){
  const st=source.statutory,used=st.taxBasisOpeningExemptionUsed;
  if(st.taxBasisOpeningExemptionYear!==input.year||!object(used))continue;
  if(Object.entries(used).some(([code,n])=>! /^(PCB_|LP_)/.test(code)||typeof n!=='number'||!Number.isFinite(n)||n<0||!Number.isSafeInteger(Math.round(n*100))||Math.abs(n*100-Math.round(n*100))>1e-6))return{state:'conflict',reason:'Saved prior-employer exemption evidence contains invalid amounts.'};
  if(lacking.length){
   const lineage=st.taxBasisOpeningSource;
   if(!object(lineage)||lineage.version!==1||lineage.year!==input.year||lineage.employmentId!==input.employmentId||lineage.companyId!==input.companyId||!Array.isArray(lineage.prefix))continue;
   const prefix=lineage.prefix;
   if(lacking.some(original=>!prefix.some((ref:unknown)=>object(ref)&&ref.payslipId===original.id&&ref.sourceHash===original.sourceHash)))continue;
  }
  candidates.push({id:source.id,used:used as Record<string,number>});
 }
 if(!candidates.length)return{state:'missing',reason:'Original prior-employer exemption usage was not saved with matching assessment-year, employer, employee and source-prefix evidence. An explicitly evidenced zero is also required.'};
 if(new Set(candidates.map(candidate=>canonical(candidate.used))).size!==1)return{state:'conflict',reason:'Saved prior-employer exemption provenance differs across the selected history.'};
 return{state:'known',used:candidates[0].used,sourceIds:candidates.map(candidate=>candidate.id)};
}
