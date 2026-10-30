import 'server-only';
import {createHmac,timingSafeEqual} from 'node:crypto';
export const MOVEMENT_WORKBOOK_VERSION=2;
export type MovementWorkbookBinding={sheet:string;code:string;behaviour:string;columns:string[];captions:string[];annotationCaption?:string;identities?:{row:number;employeeCode:string}[]};
export type MovementWorkbookMetadata={version:2;keyId:string;companyName:string;companyReference:string;downloadedAt:string;catalogue:string;sheets:MovementWorkbookBinding[];signature:string};
function key(){
 const raw=process.env.MOVEMENT_IMPORT_WORKBOOK_KEY??'',id=process.env.MOVEMENT_IMPORT_WORKBOOK_KEY_ID??'';
 if(!/^[A-Za-z0-9_-]{43}$/.test(raw)||!id||id.length>64||!/^[A-Za-z0-9_.-]+$/.test(id))throw new Error('workbook_key_unavailable');
 const bytes=Buffer.from(raw,'base64url');if(bytes.length!==32||bytes.toString('base64url')!==raw)throw new Error('workbook_key_unavailable');
 return {bytes,id};
}
function mac(purpose:string,value:unknown){return createHmac('sha256',key().bytes).update('aihr:movement-workbook:v2:'+purpose+'\0').update(JSON.stringify(value)).digest('base64url');}
function same(a:string,b:string){const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);}
function payload(m:Omit<MovementWorkbookMetadata,'signature'>){return {version:m.version,keyId:m.keyId,companyName:m.companyName,companyReference:m.companyReference,downloadedAt:m.downloadedAt,catalogue:m.catalogue,sheets:m.sheets.map(s=>({sheet:s.sheet,code:s.code,behaviour:s.behaviour,columns:s.columns,captions:s.captions,annotationCaption:s.annotationCaption,identities:s.identities??[]}))};}
export function signMovementWorkbook(p:{tenantId:string;companyId:string;companyName:string;downloadedAt:string;catalogue:string;sheets:MovementWorkbookBinding[]}):MovementWorkbookMetadata{
 const base=payload({version:2,keyId:key().id,companyName:p.companyName,companyReference:'c1_'+mac('company',[p.tenantId,p.companyId,2]),downloadedAt:p.downloadedAt,catalogue:p.catalogue,sheets:p.sheets});
 return {...base,signature:mac('envelope',base)};
}
/** MAC is context binding only. Caller independently re-authorizes the company and live catalogue. */
export function verifyMovementWorkbook(raw:unknown,tenantId:string,companyId:string):MovementWorkbookMetadata{
 if(!raw||typeof raw!=='object')throw new Error('workbook_metadata_invalid');
 const m=raw as MovementWorkbookMetadata;
 if(m.version!==2||m.keyId!==key().id||typeof m.companyName!=='string'||m.companyName.length>500||typeof m.downloadedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T/.test(m.downloadedAt)||typeof m.catalogue!=='string'||!Array.isArray(m.sheets)||!m.sheets.length||m.sheets.length>1000||typeof m.signature!=='string'||typeof m.companyReference!=='string')throw new Error('workbook_metadata_invalid');
 if(JSON.stringify(raw).length>1_200_000)throw new Error('workbook_metadata_invalid');
 const names=new Set<string>(),codes=new Set<string>();
 for(const s of m.sheets){
  if(!s||typeof s.sheet!=='string'||s.sheet.length>31||!s.sheet||typeof s.code!=='string'||s.code.length>80||typeof s.behaviour!=='string'||!Array.isArray(s.columns)||s.columns.length>80||s.columns.some(c=>typeof c!=='string'||c.length>100)||!Array.isArray(s.captions)||s.captions.length!==s.columns.length||s.captions.some(c=>typeof c!=='string'||c.length>500)||s.annotationCaption!==undefined&&(typeof s.annotationCaption!=='string'||s.annotationCaption.length>500)||names.has(s.sheet.toLowerCase())||codes.has(s.code))throw new Error('workbook_metadata_invalid');
  names.add(s.sheet.toLowerCase());codes.add(s.code);
  if(s.identities&&(!Array.isArray(s.identities)||s.identities.length>50||s.identities.some(r=>!Number.isSafeInteger(r.row)||r.row<6||typeof r.employeeCode!=='string'||r.employeeCode.length>100)))throw new Error('workbook_metadata_invalid');
 }
 const base=payload(m);
 if(!same(m.signature,mac('envelope',base)))throw new Error('workbook_metadata_invalid');
 if(!same(m.companyReference,'c1_'+mac('company',[tenantId,companyId,2])))throw new Error('workbook_company_mismatch');
 return {...base,signature:m.signature};
}

/** Display-only result receipt; no write authority or stored upload/session is created. */
export function movementErrorReceipt(p:{tenantId:string;userId:string;companyId:string;sourceHash:string;rows:{row:number;errors:string[]}[]}){
 const body={...p,keyId:key().id};return Buffer.from(JSON.stringify({body,signature:mac('error-result',body)})).toString('base64url');
}
export function verifyMovementErrorReceipt(token:string,context:{tenantId:string;userId:string;companyId:string;sourceHash:string}){
 if(!token||token.length>1_400_000)throw new Error('workbook_metadata_invalid');
 let value;try{value=JSON.parse(Buffer.from(token,'base64url').toString('utf8'));}catch{throw new Error('workbook_metadata_invalid');}
 const p=value?.body;if(!p||p.keyId!==key().id||typeof value.signature!=='string'||!same(value.signature,mac('error-result',p))||Object.entries(context).some(([k,v])=>p[k]!==v)||!Array.isArray(p.rows)||p.rows.length>200)throw new Error('workbook_metadata_invalid');
 return p.rows as {row:number;errors:string[]}[];
}

/**
 * ac6645ec (ADR-0156) — the single-sheet template is signed to the TENANT and the movement-type catalogue,
 * not to a company: Company ID is a per-row cell resolved and authorized by the server. The MAC is context
 * binding only; it never authorizes a company, employee or value.
 */
/** 646355e5 slice C — version 4 signs the eleven captions (Action, Movement Event ID and Reason appended);
 * version 3 (eight captions) stays readable and imports as Create only. */
export type MovementTemplateMetadata={version:3|4;keyId:string;tenantReference:string;downloadedAt:string;catalogue:string;captions:string[];signature:string};
function templatePayload(m:Omit<MovementTemplateMetadata,'signature'>){return {version:m.version,keyId:m.keyId,tenantReference:m.tenantReference,downloadedAt:m.downloadedAt,catalogue:m.catalogue,captions:m.captions};}
export function signMovementTemplate(p:{tenantId:string;downloadedAt:string;catalogue:string;captions:string[];version?:3|4}):MovementTemplateMetadata{
 const version=p.version??4;
 const base=templatePayload({version,keyId:key().id,tenantReference:'t1_'+mac('tenant',[p.tenantId,version]),downloadedAt:p.downloadedAt,catalogue:p.catalogue,captions:p.captions});
 return {...base,signature:mac('template',base)};
}
export function verifyMovementTemplate(raw:unknown,tenantId:string):MovementTemplateMetadata{
 if(!raw||typeof raw!=='object')throw new Error('workbook_metadata_invalid');
 const m=raw as MovementTemplateMetadata;
 // A per-type workbook (version 2) is a retired layout, not a corrupt file: say so plainly.
 if((raw as {version?:unknown}).version===2)throw new Error('workbook_old_layout');
 if(m.version!==3&&m.version!==4||m.captions?.length!==(m.version===3?8:11)||m.keyId!==key().id||typeof m.tenantReference!=='string'||typeof m.downloadedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T/.test(m.downloadedAt)||typeof m.catalogue!=='string'||!Array.isArray(m.captions)||m.captions.length>20||m.captions.some(c=>typeof c!=='string'||c.length>200)||typeof m.signature!=='string')throw new Error('workbook_metadata_invalid');
 const base=templatePayload(m);
 if(!same(m.signature,mac('template',base)))throw new Error('workbook_metadata_invalid');
 if(!same(m.tenantReference,'t1_'+mac('tenant',[tenantId,m.version])))throw new Error('workbook_metadata_invalid');
 return {...base,signature:m.signature};
}

export function movementWorkbookSigningReady(){try{key();return true;}catch{return false;}}
