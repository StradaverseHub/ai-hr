/** Navigation-only head identities. Canonical label writers independently validate every saved head. */
export type LabelHeadChoice={employmentId:string;companyId:string;employeeCode:string|null;name:string};
export type LabelHeadChoiceInput={companyId:string;query?:string;offset?:number;selectedId?:string};
export type LabelHeadChoicePage={companyId:string;query:string;offset:number;limit:25;total:number;rows:LabelHeadChoice[];selected:LabelHeadChoice|null};
export const LABEL_HEAD_CHOICE_PAGE_SIZE=25;
export class LabelHeadChoiceInputError extends Error {constructor(){super('Invalid head choice request');this.name='LabelHeadChoiceInputError';}}
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export function parseLabelHeadChoiceInput(raw:unknown):Required<Pick<LabelHeadChoiceInput,'companyId'|'query'|'offset'>>&Pick<LabelHeadChoiceInput,'selectedId'>{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new LabelHeadChoiceInputError();
 const p=raw as Record<string,unknown>;
 if(Object.keys(p).some(key=>!['companyId','query','offset','selectedId'].includes(key))
  ||typeof p.companyId!=='string'||!uuid.test(p.companyId)
  ||p.query!==undefined&&(typeof p.query!=='string'||p.query.length>1000||p.query.includes('\0'))
  ||p.offset!==undefined&&(typeof p.offset!=='number'||!Number.isSafeInteger(p.offset)||p.offset<0||p.offset>Number.MAX_SAFE_INTEGER-LABEL_HEAD_CHOICE_PAGE_SIZE)
  ||p.selectedId!==undefined&&(typeof p.selectedId!=='string'||p.selectedId!==''&&!uuid.test(p.selectedId)))throw new LabelHeadChoiceInputError();
 return {companyId:p.companyId.toLowerCase(),query:typeof p.query==='string'?p.query.trim():'',offset:typeof p.offset==='number'?p.offset:0,
  ...(typeof p.selectedId==='string'&&p.selectedId?{selectedId:p.selectedId.toLowerCase()}:{})};
}
export function labelHeadChoiceRequestKey(companyId:string,query:string,offset:number,selectedId?:string){
 return JSON.stringify([companyId.toLowerCase(),query.trim(),offset,selectedId?.toLowerCase()??'']);
}
export function labelHeadChoiceLabel(row:Pick<LabelHeadChoice,'name'|'employeeCode'>){return row.employeeCode?`${row.name} (${row.employeeCode})`:row.name;}
export function isLabelHeadChoicePage(raw:unknown):raw is LabelHeadChoicePage{
 if(!raw||typeof raw!=='object')return false;const p=raw as LabelHeadChoicePage;
 const row=(r:LabelHeadChoice)=>Boolean(r)&&typeof r.employmentId==='string'&&uuid.test(r.employmentId)&&r.companyId===p.companyId
  &&typeof r.name==='string'&&(r.employeeCode===null||typeof r.employeeCode==='string');
 return typeof p.companyId==='string'&&uuid.test(p.companyId)&&typeof p.query==='string'&&Number.isSafeInteger(p.offset)&&p.offset>=0
  &&p.offset<=Number.MAX_SAFE_INTEGER-LABEL_HEAD_CHOICE_PAGE_SIZE&&p.limit===LABEL_HEAD_CHOICE_PAGE_SIZE&&Number.isSafeInteger(p.total)&&p.total>=0&&Array.isArray(p.rows)&&p.rows.length<=p.limit
  &&(!p.rows.length||p.offset+p.rows.length<=p.total)
  &&p.rows.every(row)&&new Set(p.rows.map(row=>row.employmentId)).size===p.rows.length&&p.total>=p.rows.length&&(p.selected===null||row(p.selected));
}
