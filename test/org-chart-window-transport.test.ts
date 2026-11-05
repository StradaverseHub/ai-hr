import {expect,it} from 'vitest';
import {decodeOrgWindow,type OrgWindow} from '../lib/org-chart-window';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const person={employmentId:id(1),name:'Visible',employeeCode:null,role:null,department:null,assignmentCount:0};
const base:OrgWindow={version:1,view:'roots',focus:null,items:[{key:id(1),node:person,otherEmploymentId:id(1),type:null,direction:null,inSelectedScope:true}],totalItems:1,totalPeople:1,pageSize:50,nextCursor:null};
it('validates the bounded DTO and preserves an explicit unlabelled cross-company connection',()=>{
 expect(decodeOrgWindow(base,{view:'roots'})).toEqual(base);
 const connection:OrgWindow={...base,view:'connections',focus:person,items:[{key:id(2),node:null,otherEmploymentId:id(3),type:'dotted',direction:'incoming',inSelectedScope:false}]};
 expect(decodeOrgWindow(connection,{view:'connections',focusId:id(1)})).toEqual(connection);
});
it('rejects malformed, overlarge, stale-focus and falsely complete payloads',()=>{
 for(const bad of [{}, {...base,items:Array(51).fill(base.items[0])},{...base,totalItems:0},{...base,nextCursor:id(1)},{...base,items:[{...base.items[0],node:null}]},{...base,view:'children',focus:person}])expect(()=>decodeOrgWindow(bad,{view:'roots'})).toThrow();
 expect(()=>decodeOrgWindow({...base,view:'children',focus:person},{view:'children',focusId:id(2)})).toThrow();
});
