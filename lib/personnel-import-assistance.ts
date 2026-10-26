/** Header-only proposal contract. Never carries rows, cell values, file/sheet names or provider secrets. */
import {z} from 'zod';
import {EMPLOYEE_TEMPLATE_COLUMNS} from './import-schema';
import {PERSONNEL_FIELDS} from './personnel-field-registry';
import {personnelColumnLabel} from './personnel-import-contract';
const columns=[...EMPLOYEE_TEMPLATE_COLUMNS.required,...EMPLOYEE_TEMPLATE_COLUMNS.optional];
const fields=new Set(columns);
export const PERSONNEL_IMPORT_ASSISTANCE_REGISTRY=Object.freeze(columns.map(column=>{
 const field=PERSONNEL_FIELDS.find(f=>f.import.column===column&&f.import.section!=='family');
 return Object.freeze({field:column,label:personnelColumnLabel(column),required:(EMPLOYEE_TEMPLATE_COLUMNS.required as readonly string[]).includes(column),aliases:Object.freeze([...(field?.import.aliases??[])])});
}));
export const personnelImportRegistryRevisionText=()=>JSON.stringify(PERSONNEL_IMPORT_ASSISTANCE_REGISTRY);
const Index=z.number().int().min(0).max(16383),Digest=z.string().regex(/^[a-f0-9]{64}$/),Field=z.string().refine(value=>fields.has(value));
export const PersonnelImportHeaderSchema=z.object({columnIndex:Index,heading:z.string().trim().min(1).max(96)}).strict();
export type PersonnelImportHeader=z.infer<typeof PersonnelImportHeaderSchema>;
export const PersonnelImportHeaderMappingSchema=z.discriminatedUnion('status',[
 z.object({columnIndex:Index,status:z.literal('mapped'),field:Field}).strict(),
 z.object({columnIndex:Index,status:z.literal('ambiguous'),fields:z.array(Field).min(2).max(5)}).strict(),
 z.object({columnIndex:Index,status:z.literal('unresolved')}).strict()
]);
export const PersonnelImportHeaderProposalSchema=z.object({version:z.literal(1),sourceRevision:Digest,registryDigest:Digest,mappings:z.array(PersonnelImportHeaderMappingSchema).min(1).max(128)}).strict();
export type PersonnelImportHeaderProposal=z.infer<typeof PersonnelImportHeaderProposalSchema>;
export const PersonnelImportHeaderAssistanceRequestSchema=z.object({version:z.literal(1),companyId:z.string().uuid(),operationNonce:z.string().uuid(),headers:z.array(PersonnelImportHeaderSchema).min(1).max(128),sourceRevision:Digest,registryDigest:Digest,mode:z.enum(['deterministic','ai']),consent:z.object({headersReviewed:z.literal(true),sendHeadingsOnly:z.boolean()}).strict()}).strict().superRefine((value,ctx)=>{if(value.mode==='ai'&&(!value.consent.sendHeadingsOnly||value.headers.length>32))ctx.addIssue({code:z.ZodIssueCode.custom,message:'Header proposal unavailable'});});
export type PersonnelImportHeaderAssistanceRequest=z.infer<typeof PersonnelImportHeaderAssistanceRequestSchema>;
export type PersonnelImportHeaderAssistanceResult=Readonly<{kind:'proposal';attemptId:string;attemptVersion:string;proposal:PersonnelImportHeaderProposal}>|Readonly<{kind:'unavailable';message:string}>;
export const personnelImportHeadersRevisionText=(headers:readonly PersonnelImportHeader[])=>JSON.stringify(headers.map(h=>({columnIndex:h.columnIndex,heading:h.heading})));
export const personnelImportSourceRevisionText=(headersDigest:string,registryDigest:string)=>JSON.stringify([headersDigest,registryDigest]);
export function capturePersonnelImportHeaders(value:unknown):readonly PersonnelImportHeader[]{
 const headers=z.array(PersonnelImportHeaderSchema).min(1).max(128).parse(value),indexes=new Set<number>(),headings=new Set<string>();
 let bytes=0;for(const header of headers){const normalized=header.heading.normalize('NFKC').toLocaleLowerCase('en').replace(/\s+/g,' ');if(indexes.has(header.columnIndex)||headings.has(normalized)||/[\u0000-\u001f\u007f]/.test(header.heading))throw Error('Header proposal unavailable');indexes.add(header.columnIndex);headings.add(normalized);bytes+=new TextEncoder().encode(header.heading).length;}
 if(bytes>8192||headers.some((h,i)=>i>0&&h.columnIndex<=headers[i-1].columnIndex))throw Error('Header proposal unavailable');
 return Object.freeze(headers.map(h=>Object.freeze({...h})));
}
export function capturePersonnelImportHeaderProposal(value:unknown,indexedHeaders:readonly Pick<PersonnelImportHeader,'columnIndex'>[]):PersonnelImportHeaderProposal{
 const proposal=PersonnelImportHeaderProposalSchema.parse(value),expected=new Set(indexedHeaders.map(h=>h.columnIndex)),seen=new Set<number>(),mapped=new Set<string>();
 if(expected.size!==indexedHeaders.length||proposal.mappings.length!==expected.size)throw Error('Header proposal unavailable');
 for(const mapping of proposal.mappings){if(!expected.has(mapping.columnIndex)||seen.has(mapping.columnIndex))throw Error('Header proposal unavailable');seen.add(mapping.columnIndex);if(mapping.status==='mapped'){if(mapped.has(mapping.field))throw Error('Header proposal unavailable');mapped.add(mapping.field);}else if(mapping.status==='ambiguous'&&new Set(mapping.fields).size!==mapping.fields.length)throw Error('Header proposal unavailable');}
 return Object.freeze({...proposal,mappings:Object.freeze(proposal.mappings.map(m=>Object.freeze(m.status==='ambiguous'?{...m,fields:Object.freeze([...m.fields])}:m)))} as unknown as PersonnelImportHeaderProposal);
}
