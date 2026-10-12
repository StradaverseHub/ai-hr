import { z } from 'zod';
import { parseCsvRecords } from '../../../lib/csv';
import { scoringSchema, type Scoring } from './model';
export type ImportRecord=Record<string,string>;
export function importValue(row:ImportRecord,...names:string[]):string {return names.map(n=>row[n.replace(/\s+/g,'_').toLowerCase()]).find(v=>v?.trim())?.trim()??'';}
export function assessmentImportRecords(csv:string):ImportRecord[]{
 if(new TextEncoder().encode(csv).length>1_000_000)throw Error('Choose an import smaller than 1 MB of text.');
 const {headers,records}=parseCsvRecords(csv.replace(/^\uFEFF/,''));
 if(new Set(headers).size!==headers.length)throw Error('The import has duplicate column headings.');
 if(!records.length||records.length>5000)throw Error('Choose a file with between 1 and 5,000 rows.');
 if(records.some(r=>Object.entries(r).some(([key,value])=>/^approver_?[123](?:_|$)/i.test(key)&&value.trim())))throw Error('Approver 1/2/3 columns are retired. Use Matrix manager ID for a single moderator.');
 return records.filter(r=>Object.values(r).some(v=>v.trim()));
}
function numeric(row:ImportRecord,names:string[],required=true):number|null {
 const raw=importValue(row,...names).replaceAll(',','').replace(/%$/,'');
 if(!raw){if(!required)return null;throw Error(`Missing ${names[0]}.`);}
 const value=Number(raw);if(!Number.isFinite(value))throw Error(`${names[0]} must be a finite number.`);return value;
}
export function importScoring(row:ImportRecord,mechanism:'A'|'B',variant:'base'|'excellence'='base'):Scoring {
 const method=importValue(row,'method').toLowerCase();
 if(mechanism==='A')return scoringSchema.parse({mechanism,method,rates:[1,2,3,4,5].map(i=>numeric(row,[`Rate ${i}`,`rate${i}`]))});
 return scoringSchema.parse({mechanism,method,variant,threshold:numeric(row,['threshold']),target:numeric(row,['target']),multiple:Math.trunc(numeric(row,['multiple'],false)??0),excellence:variant==='excellence'?numeric(row,['excellence']):null});
}
export function importKpiDefinition(row:ImportRecord,mechanism:'A'|'B',variant:'base'|'excellence'='base',library=false){
 const title=z.string().trim().min(1).max(300).parse(importValue(row,'KPI','KPI name'));
 const weight=numeric(row,library?['Weightage Default','Weightage','weight']:['Weightage','Weightage %','weight'],!library);
 if(weight!=null&&(weight<=0||weight>100))throw Error('A KPI weight must be greater than 0 and at most 100%.');
 const scoring=importScoring(row,mechanism,variant);
 const positive=(...keys:string[])=>{const value=importValue(row,...keys).replaceAll(',','').replace(/%$/,'');return value&&Number.isFinite(Number(value))&&Number(value)>0?Number(value):null;};
 const rates=[1,2,3,4,5].map(i=>positive(`Spread Rate ${i}`,`spread_rate${i}`));
 const spread=mechanism==='A'?(rates.every(n=>n!=null)?{rate:rates as number[]}:null):{threshold:positive('Spread Threshold'),excellence:variant==='excellence'?positive('Spread Excellence'):null};
 return {title,category:importValue(row,'Strategic Thrust / Category','category','strategic thrust'),description:importValue(row,'KPI Description','description'),unit:importValue(row,'Unit of Measure','unit'),weightBp:weight==null?null:Math.round(weight*100),scoring,spread};
}
export const kpiTargetImportHeaders=['Employee ID','KPI','Strategic Thrust / Category','KPI Description','Unit of Measure','Weightage','Method','Rate 1','Rate 2','Rate 3','Rate 4','Rate 5','Threshold','Target','Multiple','Excellence','Matrix manager ID'];
export const kpiLibraryImportHeaders=['Business Group','Company','Department','Tier','Job Grade','KPI','Strategic Thrust / Category','KPI Description','Unit of Measure','Method','Rate 1','Rate 2','Rate 3','Rate 4','Rate 5','Threshold','Target','Multiple','Excellence','Weightage Default','Spread Rate 1','Spread Rate 2','Spread Rate 3','Spread Rate 4','Spread Rate 5','Spread Threshold','Spread Excellence'];

export const kpiLibraryTemplateSchema=z.object({title:z.string().min(1).max(300),category:z.string().max(4000),description:z.string().max(4000),unit:z.string().max(80),weightBp:z.number().finite().nullable(),scoring:scoringSchema,spread:z.object({rate:z.array(z.number()).length(5).optional(),threshold:z.number().nullable().optional(),excellence:z.number().nullable().optional()}).nullable()});
export type KpiLibraryTemplate=z.infer<typeof kpiLibraryTemplateSchema>;
