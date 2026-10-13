import { z } from 'zod';
import { todayInKualaLumpur } from '../../../lib/hr-date';
export const evidenceKinds=['delivery','problem','behaviour','learning','recognition','support','told','other'] as const;
export const evidenceDetailsSchema=z.object({
 title:z.string().trim().max(120).default(''),impact:z.string().trim().max(1200).default(''),who:z.string().trim().max(300).default(''),
 precision:z.enum(['day','week','month','quarter']).default('day'),metricValue:z.number().finite().nullable().default(null),metricUnit:z.string().trim().max(40).default(''),
 fileOnly:z.boolean().optional(),
 raisedWithSubject:z.enum(['written','discussed','no']).nullable().default(null),
});
const date=z.iso.date().refine(v=>v<=todayInKualaLumpur(),'Evidence cannot be dated in the future.');
export const evidenceFieldsSchema=z.object({kind:z.enum(evidenceKinds),body:z.string().trim().min(1).max(1200),occurredOn:date,...evidenceDetailsSchema.shape});
export type EvidenceFields=z.infer<typeof evidenceFieldsSchema>;
/** An absent field preserves the human's words; a present empty value clears only that slot. */
export function patchEvidenceFields(current:EvidenceFields,raw:unknown):EvidenceFields{
 const input=z.record(z.string(),z.unknown()).parse(raw),parsed=evidenceFieldsSchema.partial().strict().parse(input);
 const patch=Object.fromEntries(Object.keys(input).map(key=>[key,parsed[key as keyof typeof parsed]]));
 return evidenceFieldsSchema.parse({...current,...patch});
}
export const evidenceCitationSchema=z.object({userId:z.uuid(),stance:z.enum(['supports','qualifies','contradicts']),decisionKind:z.enum(['kpi_result','moderation','band_change']),at:z.iso.datetime()});
export function standingResponses<T extends {userId:string}>(responses:T[]):T[]{return [...new Map(responses.map(r=>[r.userId,r])).values()];}
export function upsertEvidenceResponse<T extends {userId:string}>(responses:T[],next:T):T[]{
 let replaced=false;const current=responses.flatMap(r=>{if(r.userId!==next.userId)return [r];if(replaced)return [];replaced=true;return [next];});return replaced?current:[...current,next];
}

export const evidenceLinkSchema=z.object({kind:z.enum(['kpi','principle','skill']),id:z.string().min(1).max(100)});
