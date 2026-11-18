/** Shared current-settings adapter for accepted immutable imported sources. */
import {createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import type {Tx} from '../db/client';
import type {CountryPack,StatutoryRuleset} from '../localization/country-pack';
import {importedTaxInput,SYSTEM_BASIC_TAX_SETTING,ImportedTaxSourceError,type ImportedTaxSetting,type ImportedTaxLine} from '../lib/payroll-import-tax-input';
import type {ImportCodeEntry} from '../lib/payroll-history-import-schema';
/** Consumer evidence excludes display-name edits; classification and exact identity remain bound. */
export function importedTaxSettingEvidence(value:unknown){
 if(!Array.isArray(value))return null;
 const keys=['id','code','kind','includedInPcb','pcbRemunerationType','pcbExemptionCode','isNonPayable','epfBonus2012','archivedAt','displayCategory','eaFormLine'];
 return value.map(setting=>Object.fromEntries(keys.map(key=>[key,setting&&typeof setting==='object'?(setting as Record<string,unknown>)[key]??null:null]))).sort((a,b)=>String(a.id).localeCompare(String(b.id)));
}
export const importedTaxSettingsHash=(settings:readonly ImportedTaxSetting[])=>createHash('sha256').update(JSON.stringify(settings)).digest('hex');
export async function importedTaxSettingsTx(tx:Tx){
 return tx.execute<ImportedTaxSetting>(sql`select id,code,name,kind,included_in_pcb as "includedInPcb",pcb_remuneration_type as "pcbRemunerationType",pcb_exemption_code as "pcbExemptionCode",is_non_payable as "isNonPayable",epf_bonus_2012 as "epfBonus2012",archived_at as "archivedAt",display_category as "displayCategory",ea_form_line as "eaFormLine" from pay_component order by id`);
}
export async function importedTaxRulesStatesTx(tx:Tx,periods:string[]){
 const result=new Map<string,{digest:string;packDisabled:boolean}>();if(!periods.length)return result;
 const rows=await tx.execute<{period:string;digest:string}>(sql`with dates as(select unnest(array[${sql.join([...new Set(periods)].map(period=>sql`${period}`),sql`, `)}]::text[]) as period),sources as(
  select d.period,'rules:'||to_jsonb(r)::text as value from dates d join statutory_ruleset r on r.country='MY' and r.effective_from<=(d.period||'-01')::date
  union all select d.period,'component:'||to_jsonb(r)::text from dates d join statutory_component_override r on r.country='MY' and r.effective_from<=(d.period||'-01')::date
  union all select d.period,'pack:'||to_jsonb(r)::text from dates d join statutory_pack r on r.country='MY' and r.effective_from<=(d.period||'-01')::date
  union all select d.period,'key:'||to_jsonb(r)::text from dates d join statutory_signing_key r on exists(select 1 from statutory_pack p where p.country='MY' and p.effective_from<=(d.period||'-01')::date and p.signed_key_id=r.key_id))
 select d.period,md5(coalesce(string_agg(s.value,',' order by s.value),'')) as digest from dates d left join sources s on s.period=d.period group by d.period order by d.period`);
 for(const row of rows)result.set(row.period,{digest:row.digest,packDisabled:process.env.STATUTORY_PACK_DISABLE==='1'});return result;
}
export async function importedTaxRulesStateTx(tx:Tx){return (await importedTaxRulesStatesTx(tx,['2999-12'])).get('2999-12')!;}
export function importTaxSettingsWithBasic(settings:readonly ImportedTaxSetting[]){return settings.some(setting=>setting.code.trim().toUpperCase()==='BASIC')?[...settings]:[...settings,SYSTEM_BASIC_TAX_SETTING];}
export function importedTaxNeedsOpening(lines:readonly ImportedTaxLine[],settings:readonly ImportedTaxSetting[],rules:StatutoryRuleset){
 return lines.some(line=>settings.some(setting=>setting.id===line.settingId&&setting.includedInPcb&&!!setting.pcbExemptionCode&&line.amount>0&&((setting.pcbRemunerationType==='optional_deduction')||line.direction!=='deduction')&&(rules.pcbExemptions?.[setting.pcbRemunerationType==='optional_deduction'?'lp':'pcb']?.[setting.pcbExemptionCode]??0)>0));
}
export type ImportedTaxBasisStamp={version:1;state:'ready'|'held';year:number;settingsHash:string;settings:ImportedTaxSetting[];lines:ImportedTaxLine[];missing:string[];rulesState?:{digest:string;packDisabled:boolean};rulesEvidence?:unknown;basis?:import('../lib/payroll-tax-basis').TaxBasisValue};
export function projectImportedTaxBasis(input:{ownerKey:string;replay:CountryPack['payroll']['replayTaxBasis'];period:string;rows:{rowNum:number;code:string;amount:number}[];codes:ReadonlyMap<string,ImportCodeEntry>;settings:readonly ImportedTaxSetting[];rules:StatutoryRuleset;rulesHash:string;rulesState?:{digest:string;packDisabled:boolean};rulesEvidence?:unknown;gross:number;deductions:number;statutory:Record<string,unknown>}):ImportedTaxBasisStamp{
 const settings=importTaxSettingsWithBasic(input.settings),year=Number(input.period.slice(0,4));let lines:ImportedTaxLine[]=[],sourceError:string|undefined;try{lines=importedTaxInput(input.rows,input.codes,settings);}catch(error){if(!(error instanceof ImportedTaxSourceError))throw error;sourceError=error.message;}
 for(const line of lines)if(line.direction==='noncash')line.nonCashSource={source:'one_off',sourceId:'import:'+createHash('sha256').update(JSON.stringify({owner:input.ownerKey,period:input.period,row:line})).digest('hex')};
 const stamp:ImportedTaxBasisStamp={version:1,state:'held',year,settingsHash:importedTaxSettingsHash(settings),settings:settings.filter(setting=>lines.some(line=>line.settingId===setting.id)),lines,missing:[],rulesEvidence:input.rulesEvidence,rulesState:input.rulesState};
 if(sourceError){stamp.missing=[sourceError];return stamp;}
 if(importedTaxNeedsOpening(lines,settings,input.rules)){stamp.missing=['Original prior-employer exemption usage and same-year annual source prefix require reviewed historical evidence.'];return stamp;}
 // Uncapped inputs do not depend on prior-employer exemption usage. No zero is asserted or saved.
 try{stamp.basis=input.replay({year,upToMonth:Number(input.period.slice(5)),slips:[{id:'accepted-import:'+createHash('sha256').update(JSON.stringify({period:input.period,lines})).digest('hex'),period:input.period,runOrder:1,sourceKind:'import',sourceLines:lines,statutory:input.statutory,expectedGross:input.gross,expectedOtherDeductions:input.deductions}],settings,rulesByPeriod:{[input.period]:{rules:input.rules,hash:input.rulesHash}},openingExemptionUsed:{},nonCashPrefixComplete:false})[0].basis;stamp.state='ready';}
 catch(error){stamp.missing=[error instanceof Error?error.message:'Imported tax inputs require review.'];}
 return stamp;
}
