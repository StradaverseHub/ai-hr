/** Shared current-settings adapter for accepted immutable imported sources. */
import {createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import type {Tx} from '../db/client';
import type {CountryPack,StatutoryRuleset} from '../localization/country-pack';
import {importedTaxInput,SYSTEM_BASIC_TAX_SETTING,type ImportedTaxSetting,type ImportedTaxLine} from '../lib/payroll-import-tax-input';
import type {ImportCodeEntry} from '../lib/payroll-history-import-schema';
export const importedTaxSettingsHash=(settings:readonly ImportedTaxSetting[])=>createHash('sha256').update(JSON.stringify(settings)).digest('hex');
export async function importedTaxSettingsTx(tx:Tx){
 return tx.execute<ImportedTaxSetting>(sql`select id,code,name,kind,included_in_pcb as "includedInPcb",pcb_remuneration_type as "pcbRemunerationType",pcb_exemption_code as "pcbExemptionCode",is_non_payable as "isNonPayable",epf_bonus_2012 as "epfBonus2012",archived_at as "archivedAt",display_category as "displayCategory",ea_form_line as "eaFormLine" from pay_component order by id`);
}
export function importTaxSettingsWithBasic(settings:readonly ImportedTaxSetting[]){return settings.some(setting=>setting.code.trim().toUpperCase()==='BASIC')?[...settings]:[...settings,SYSTEM_BASIC_TAX_SETTING];}
export function importedTaxNeedsOpening(lines:readonly ImportedTaxLine[],settings:readonly ImportedTaxSetting[],rules:StatutoryRuleset){
 return lines.some(line=>settings.some(setting=>setting.id===line.settingId&&setting.includedInPcb&&!!setting.pcbExemptionCode&&line.amount>0&&((setting.pcbRemunerationType==='optional_deduction')||line.direction!=='deduction')&&(rules.pcbExemptions?.[setting.pcbRemunerationType==='optional_deduction'?'lp':'pcb']?.[setting.pcbExemptionCode]??0)>0));
}
export type ImportedTaxBasisStamp={version:1;state:'ready'|'held';year:number;settingsHash:string;settings:ImportedTaxSetting[];lines:ImportedTaxLine[];missing:string[];rulesEvidence?:unknown;basis?:import('../lib/payroll-tax-basis').TaxBasisValue};
export function projectImportedTaxBasis(input:{replay:CountryPack['payroll']['replayTaxBasis'];period:string;rows:{rowNum:number;code:string;amount:number}[];codes:ReadonlyMap<string,ImportCodeEntry>;settings:readonly ImportedTaxSetting[];rules:StatutoryRuleset;rulesHash:string;rulesEvidence?:unknown;gross:number;deductions:number;statutory:Record<string,unknown>}):ImportedTaxBasisStamp{
 const settings=importTaxSettingsWithBasic(input.settings),lines=importedTaxInput(input.rows,input.codes,settings),year=Number(input.period.slice(0,4));
 const stamp:ImportedTaxBasisStamp={version:1,state:'held',year,settingsHash:importedTaxSettingsHash(settings),settings:settings.filter(setting=>lines.some(line=>line.settingId===setting.id)),lines,missing:[],rulesEvidence:input.rulesEvidence};
 if(importedTaxNeedsOpening(lines,settings,input.rules)){stamp.missing=['Original prior-employer exemption usage and same-year annual source prefix require reviewed historical evidence.'];return stamp;}
 // Uncapped inputs do not depend on prior-employer exemption usage. No zero is asserted or saved.
 try{stamp.basis=input.replay({year,upToMonth:Number(input.period.slice(5)),slips:[{id:'accepted-import:'+createHash('sha256').update(JSON.stringify({period:input.period,lines})).digest('hex'),period:input.period,runOrder:1,sourceLines:lines,statutory:input.statutory,expectedGross:input.gross,expectedOtherDeductions:input.deductions}],settings,rulesByPeriod:{[input.period]:{rules:input.rules,hash:input.rulesHash}},openingExemptionUsed:{}})[0].basis;stamp.state='ready';}
 catch(error){stamp.missing=[error instanceof Error?error.message:'Imported tax inputs require review.'];}
 return stamp;
}
