/** Accepted-TP3 opening for an explicit historical income-tax recalculation (ADR-0167, 23 November 2026 owner decision,
 * board item 0af23331). Pure: the caller reads the rows set-wise and supplies the canonical TP3 mapping from core/tp3.ts.
 *
 * Order, after saved payslip opening evidence (lib/payroll-tax-opening-evidence.ts) has resolved as missing:
 *  1. the employee's accepted TP3 for the assessment year, the canonical employee_tp3 record, per exemption code;
 *  2. otherwise the employee_statutory_my projection whose tp3_year is that year (what live payroll applies);
 *  3. otherwise RM0, even when the employee answered that they had a previous employer (the answer is shown as a warning).
 * A caller who cannot see the person's TP3 and applied opening never gets a zero: absence there is not evidence.
 * employee_tp3_draft is private staging and is never an input. */
import type {TaxBasisOpening,TaxBasisLedgerCode,TaxBasisLedgerEntry,TaxOpeningSource} from './payroll-tax-basis';

export type TaxOpeningRow={
 id:string;access:boolean;
 tp3Id:string|null;tp3Revision:string|null;tp3Payload:unknown;
 projection:boolean;projectionUsed:unknown;projectionRevision:string|null;
 declared:boolean|null;answerId:string|null;
};
export type Tp3OpeningResolution={state:'resolved';opening:TaxBasisOpening}|{state:'access_insufficient'}|{state:'unreadable';reason:string};
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const round2=(n:number)=>Math.round(n*100)/100;

/** The same filter live payroll applies to the projection (core/payroll.ts): only a positive amount is headroom taken. */
export function positiveOpening(value:unknown):Record<string,number>{
 const out:Record<string,number>={};
 if(!object(value))return out;
 for(const [code,amount] of Object.entries(value)){const used=round2(Number(amount??0));if(Number.isFinite(used)&&used>0)out[code]=used;}
 return Object.fromEntries(Object.entries(out).sort(([a],[b])=>a.localeCompare(b)));
}

export function resolveTp3Opening(row:TaxOpeningRow|undefined,formExemptionUsed:(payload:unknown)=>Record<string,number>|null):Tp3OpeningResolution{
 if(!row||!row.access)return {state:'access_insufficient'};
 const declared=row.declared===true;
 if(row.tp3Id){
  // An accepted form with no Section C records no exemption use; absent keys mean "not used", as in core/tp3.ts.
  const used=row.tp3Payload==null?{}:formExemptionUsed(row.tp3Payload);
  if(used===null)return {state:'unreadable',reason:'The accepted TP3 for this year uses an unsupported form version.'};
  return {state:'resolved',opening:{source:'accepted_tp3',used:positiveOpening(used),tp3:{kind:'form',id:row.tp3Id,revision:row.tp3Revision??''}}};
 }
 if(row.projection)return {state:'resolved',opening:{source:'accepted_tp3',used:positiveOpening(row.projectionUsed),tp3:{kind:'statutory_projection',id:null,revision:row.projectionRevision??''}}};
 return {state:'resolved',opening:{source:'no_accepted_tp3',used:{},previousEmployerDeclared:declared}};
}

/** Digest descriptor: identity and revision of every opening input, never names or amounts beyond the stored map. */
export function taxOpeningDigestRow(row:TaxOpeningRow){
 return [row.id,row.access,row.tp3Id,row.tp3Revision,row.projection?row.projectionRevision:null,row.projection?positiveOpening(row.projectionUsed):null,row.declared,row.answerId];
}

/** Per-code summary of the pack's ledger entries. Sums and the last running figure only; the pack owns every limit. */
export function summarizeExemptionLedger(entries:readonly TaxBasisLedgerEntry[],opening:Record<string,number>,openingSource:TaxOpeningSource|null):TaxBasisLedgerCode[]{
 const byCode=new Map<string,TaxBasisLedgerCode>();
 for(const entry of entries){
  const code=byCode.get(entry.code)??{code:entry.code,cap:entry.cap,openingUsed:round2(opening[entry.code]??0),openingSource,eligible:0,exempt:0,excess:0,usedAfter:0,remaining:entry.cap,items:[]};
  code.eligible=round2(code.eligible+entry.eligible);code.exempt=round2(code.exempt+entry.exempt);code.excess=round2(code.excess+entry.excess);
  code.usedAfter=entry.usedAfter;code.remaining=entry.remainingAfter;
  if(!code.items.some(item=>item.code===entry.itemCode))code.items.push({code:entry.itemCode,name:entry.itemName});
  byCode.set(entry.code,code);
 }
 return [...byCode.values()].sort((a,b)=>a.code.localeCompare(b.code));
}
