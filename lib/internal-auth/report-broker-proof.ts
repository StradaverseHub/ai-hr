/** Auth-key AEAD inspection constraint. No credential, relay secret or caller authority is sealed. */
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {encryptRecord,decryptRecord} from './crypto';
import {internalConfig} from './config';
import {REPORT_INSPECTION_MAX_CHARS} from './report-broker-model';
const PURPOSE='managed-report-inspection-v1';
export const REPORT_INSPECTION_LIFETIME_MS=60_000;
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const identity=z.object({issuer:z.string().max(500),subject:z.uuid(),userId:z.uuid(),personId:z.uuid().nullable(),bindingCreatedAt:z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),credentialVersion:z.uuid()}).strict();
export const reportInspectionClaims=z.object({v:z.literal(1),purpose:z.literal(PURPOSE),origin:z.string().max(458),occurrenceId:z.uuid(),leaseToken:z.uuid(),issuedAt:z.number().int().nonnegative().safe(),expiresAt:z.number().int().nonnegative().safe(),targetDigest:digest,accessStamp:digest,identities:z.object({owner:identity,recipient:identity}).strict(),relayRevision:z.union([z.literal('initial'),z.string().regex(/^[A-Za-z0-9_-]{43}$/)])}).strict()
 .refine(value=>value.expiresAt>value.issuedAt&&value.expiresAt-value.issuedAt<=REPORT_INSPECTION_LIFETIME_MS);
export type ReportInspectionClaims=z.infer<typeof reportInspectionClaims>;
/** Strict parsed DTOs have finite JSON values. Sort object keys, preserve ordered arrays. */
export function reportProofDigest(value:unknown):string {
 const canonical=(item:unknown):string=>{
  if(item===null||typeof item==='boolean'||typeof item==='string'||typeof item==='number'&&Number.isFinite(item))return JSON.stringify(item);
  if(Array.isArray(item))return '['+item.map(canonical).join(',')+']';
  if(item&&typeof item==='object'&&Object.getPrototypeOf(item)===Object.prototype)return '{'+Object.keys(item).sort().map(key=>JSON.stringify(key)+':'+canonical((item as Record<string,unknown>)[key])).join(',')+'}';
  throw new Error('Invalid report proof value.');
 };
 return createHash('sha256').update(canonical(value)).digest('hex');
}
export function sealReportInspection(claims:ReportInspectionClaims):string {
 const parsed=reportInspectionClaims.parse(claims);
 if(parsed.origin!==internalConfig().origin)throw new Error('Invalid report inspection origin.');
 const proof=encryptRecord(parsed,PURPOSE,parsed.expiresAt);
 if(proof.length>REPORT_INSPECTION_MAX_CHARS)throw new Error('Report inspection exceeded its bound.');
 return proof;
}
export function openReportInspection(proof:string,nonce:{occurrenceId:string;leaseToken:string},now=Date.now()):ReportInspectionClaims|null {
 if(proof.length>REPORT_INSPECTION_MAX_CHARS||!proof.length||!/^[A-Za-z0-9_-]+$/.test(proof))return null;
 try{
  const parsed=reportInspectionClaims.safeParse(decryptRecord<unknown>(proof,PURPOSE,now));
  if(!parsed.success)return null;
  const value=parsed.data;
  return value.origin===internalConfig().origin&&value.occurrenceId===nonce.occurrenceId&&value.leaseToken===nonce.leaseToken&&value.issuedAt<=now&&value.expiresAt>now?value:null;
 }catch{return null;}
}
