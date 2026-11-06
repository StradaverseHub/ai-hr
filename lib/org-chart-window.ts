/** Browser-safe bounded Org transport. Permission decisions remain native and fresh. */
export const ORG_WINDOW_SIZE=50;
export type OrgRelation='administrative'|'functional'|'project'|'dotted';
export type OrgWindowView='roots'|'children'|'parents'|'search'|'connections';
export type OrgWindowNode={employmentId:string;name:string;employeeCode:string|null;role:string|null;department:string|null;assignmentCount:number};
export type OrgWindowItem={key:string;node:OrgWindowNode|null;otherEmploymentId:string;type:OrgRelation|null;direction:'outgoing'|'incoming'|null;inSelectedScope:boolean};
export type OrgWindowRequest={view:OrgWindowView;focusId?:string;after?:string;q?:string};
export type OrgWindow={version:1;view:OrgWindowView;focus:OrgWindowNode|null;items:OrgWindowItem[];totalPeople:number;totalItems:number;pageSize:number;nextCursor:string|null};

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const count=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0;
const nullableText=(v:unknown)=>v===null||typeof v==='string';
function node(v:unknown):v is OrgWindowNode{
 return record(v)&&typeof v.employmentId==='string'&&UUID.test(v.employmentId)&&typeof v.name==='string'
  &&nullableText(v.employeeCode)&&nullableText(v.role)&&nullableText(v.department)&&count(v.assignmentCount);
}
/** Reject a stale/malformed response rather than present it as a complete empty organization. */
export class OrgWindowContextChangedError extends Error{
 constructor(){super('Organization browser context changed');this.name='OrgWindowContextChangedError';}
}
export function decodeOrgWindow(value:unknown,request:OrgWindowRequest,expectedBrowserKey?:string):OrgWindow{
 if(expectedBrowserKey!==undefined){
  if(record(value)&&typeof value.browserKey==='string'&&value.browserKey!==expectedBrowserKey)throw new OrgWindowContextChangedError();
  if(!record(value)||value.browserKey!==expectedBrowserKey)throw new Error('Missing organization browser context');
 }
 const focused=['children','parents','connections'].includes(request.view);
 if(!record(value)||value.version!==1||value.view!==request.view||value.pageSize!==ORG_WINDOW_SIZE
  ||!count(value.totalPeople)||!count(value.totalItems)||!Array.isArray(value.items)||value.items.length>ORG_WINDOW_SIZE
  ||value.items.length>Number(value.totalItems)||!(value.nextCursor===null||typeof value.nextCursor==='string'&&UUID.test(value.nextCursor))
  ||(focused?(!node(value.focus)||value.focus.employmentId!==request.focusId):value.focus!==null))throw new Error('Invalid organization response');
 const keys=new Set<string>();
 for(const item of value.items){
  if(!record(item)||typeof item.key!=='string'||!UUID.test(item.key)||keys.has(item.key)
   ||typeof item.otherEmploymentId!=='string'||!UUID.test(item.otherEmploymentId)||typeof item.inSelectedScope!=='boolean'
   ||(item.inSelectedScope?(!node(item.node)||item.node.employmentId!==item.otherEmploymentId):item.node!==null)
   ||(request.view==='connections'?(!['administrative','functional','project','dotted'].includes(String(item.type))||!['incoming','outgoing'].includes(String(item.direction))):!item.inSelectedScope))throw new Error('Invalid organization item');
  keys.add(item.key);
 }
 if(value.nextCursor!==null&&(value.items.length!==ORG_WINDOW_SIZE||value.items.at(-1)?.key!==value.nextCursor))throw new Error('Invalid organization cursor');
 return value as OrgWindow;
}
