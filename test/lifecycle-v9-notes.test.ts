import { expect, it } from 'vitest';
import { changeV9Note } from '../lib/lifecycle-v9-notes';
import { fictionalV9Case,fictionalV9Task } from './fixtures/lifecycle-v9/case';
import type { Environment } from '../lib/lifecycle-v9-model';
function fixture(){let id=0;const c=fictionalV9Case({tasks:[fictionalV9Task('task')],items:[{id:'item',name:'Fictional item',kind:'device',sourceId:null,group:null,assignee:null,dueOn:'2026-11-30',status:'todo',reason:''}]});const env={actor:{id:'author',name:'Actual HR'},now:'2026-10-30T00:00:00Z',nextId:()=>String(++id),eligibleUser:(id:string)=>['author','colleague'].includes(id)} as Environment;return {c,env};}
it('retains author, mentions and revision history when notes are edited or deleted',()=>{
 const {c,env}=fixture();changeV9Note(c,env,{type:'note',context:'task',body:'Original @Colleague',mentions:['colleague','colleague']});const note=c.notes![0];
 expect(note).toMatchObject({by:'author',name:'Actual HR',mentions:['colleague'],edited:false,deleted:false});
 changeV9Note(c,env,{type:'note',id:note.id,context:'task',body:'Revised',mentions:[]});expect(note.revisions).toMatchObject([{body:'Original @Colleague',mentions:['colleague'],deleted:false,by:'author'}]);
 changeV9Note(c,env,{type:'note',id:note.id,context:'task',body:'',mentions:[],deleted:true});expect(note).toMatchObject({body:'Revised',deleted:true});expect(note.revisions).toHaveLength(2);
 expect(c.log.map(entry=>entry.action)).toEqual(['note.added','note.edited','note.deleted']);
});
it('rejects another author, another conversation, inactive mentions and closed cases',()=>{
 const {c,env}=fixture();changeV9Note(c,env,{type:'note',context:'item',body:'Original',mentions:[]});const note=c.notes![0];const original=JSON.stringify(c);
 expect(()=>changeV9Note(c,{...env,actor:{id:'colleague',name:'Other'}},{type:'note',id:note.id,context:'item',body:'Overwrite',mentions:[]})).toThrow('Only the author');
 expect(()=>changeV9Note(c,env,{type:'note',id:note.id,context:'task',body:'Move',mentions:[]})).toThrow('not found');
 expect(()=>changeV9Note(c,env,{type:'note',context:'unknown',body:'New',mentions:[]})).toThrow('existing');
 expect(()=>changeV9Note(c,env,{type:'note',context:'case',body:'New',mentions:['inactive']})).toThrow('active');
 expect(JSON.stringify(c)).toBe(original);c.state='cleared';expect(()=>changeV9Note(c,env,{type:'note',context:'case',body:'New',mentions:[]})).toThrow('Reopen');
});
