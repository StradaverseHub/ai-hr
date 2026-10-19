import 'server-only';
import {createHmac,timingSafeEqual} from 'node:crypto';
export const MOVEMENT_WORKBOOK_VERSION=2;
export type MovementWorkbookBinding={sheet:string;code:string;behaviour:string;columns:string[];identities?:{row:number;employeeCode:string}[]};
export type MovementWorkbookMetadata={version:2;keyId:string;companyName:string;companyReference:string;downloadedAt:string;catalogue:string;sheets:MovementWorkbookBinding[];signature:string};
function key(){
 const raw=process.env.MOVEMENT_IMPORT_WORKBOOK_KEY??'',id=process.env.MOVEMENT_IMPORT_WORKBOOK_KEY_ID??'';
 if(!/^[A-Za-z0-9_-]{43}$/.test(raw)||!id||id.length>64||!/^[A-Za-z0-9_.-]+$/.test(id))throw new Error('workbook_key_unavailable');
 const bytes=Buffer.from(raw,'base64url');if(bytes.length!==32||bytes.toString('base64url')!==raw)throw new Error('workbook_key_unavailable');
 return {bytes,id};
}
function mac(purpose:string,value:unknown){return createHmac('sha256',key().bytes).update('aihr:movement-workbook:v2:'+purpose+'\0').update(JSON.stringify(value)).digest('base64url');}
function same(a:string,b:string){const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);}
function payload(m:Omit<MovementWorkbookMetadata,'signature'>){return {version:m.version,keyId:m.keyId,companyName:m.companyName,companyReference:m.companyReference,downloadedAt:m.downloadedAt,catalogue:m.catalogue,sheets:m.sheets.map(s=>({sheet:s.sheet,code:s.code,behaviour:s.behaviour,columns:s.columns,identities:s.identities??[]}))};}
export function signMovementWorkbook(p:{tenantId:string;companyId:string;companyName:string;downloadedAt:string;catalogue:string;sheets:MovementWorkbookBinding[]}):MovementWorkbookMetadata{
 const base=payload({version:2,keyId:key().id,companyName:p.companyName,companyReference:'c1_'+mac('company',[p.tenantId,p.companyId,2]),downloadedAt:p.downloadedAt,catalogue:p.catalogue,sheets:p.sheets});
 return {...base,signature:mac('envelope',base)};
}
/** MAC is context binding only. Caller independently re-authorizes the company and live catalogue. */
export function verifyMovementWorkbook(raw:unknown,tenantId:string,companyId:string):MovementWorkbookMetadata{
 if(!raw||typeof raw!=='object')throw new Error('workbook_metadata_invalid');
 const m=raw as MovementWorkbookMetadata;
 if(m.version!==2||m.keyId!==key().id||typeof m.companyName!=='string'||m.companyName.length>500||typeof m.downloadedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T/.test(m.downloadedAt)||typeof m.catalogue!=='string'||!Array.isArray(m.sheets)||!m.sheets.length||m.sheets.length>1000||typeof m.signature!=='string'||typeof m.companyReference!=='string')throw new Error('workbook_metadata_invalid');
 if(JSON.stringify(raw).length>180000)throw new Error('workbook_metadata_invalid');
 const names=new Set<string>(),codes=new Set<string>();
 for(const s of m.sheets){
  if(!s||typeof s.sheet!=='string'||s.sheet.length>31||!s.sheet||typeof s.code!=='string'||s.code.length>80||typeof s.behaviour!=='string'||!Array.isArray(s.columns)||s.columns.length>80||s.columns.some(c=>typeof c!=='string'||c.length>100)||names.has(s.sheet)||codes.has(s.code))throw new Error('workbook_metadata_invalid');
  names.add(s.sheet);codes.add(s.code);
  if(s.identities&&(!Array.isArray(s.identities)||s.identities.length>50||s.identities.some(r=>!Number.isSafeInteger(r.row)||r.row<6||typeof r.employeeCode!=='string'||r.employeeCode.length>100)))throw new Error('workbook_metadata_invalid');
 }
 const base=payload(m);
 if(!same(m.signature,mac('envelope',base)))throw new Error('workbook_metadata_invalid');
 if(!same(m.companyReference,'c1_'+mac('company',[tenantId,companyId,2])))throw new Error('workbook_company_mismatch');
 return {...base,signature:m.signature};
}
