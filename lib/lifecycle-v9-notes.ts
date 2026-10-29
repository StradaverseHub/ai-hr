import type { Case, Environment } from './lifecycle-v9-model';
import { V9Error, appendLog } from './lifecycle-v9-model';
export type CaseNoteCommand = { type: 'note'; id?: string; context: string; body: string; mentions: string[]; deleted?: boolean };
/** Case and task/item identities define conversations. A mention is text routing, never an access grant. */
export function changeV9Note(c:Case,env:Environment,input:CaseNoteCommand):void {
  if(!['pending','submitted'].includes(c.state))throw new V9Error('Reopen this case before changing its notes.');
  if(input.context!=='case'&&!c.tasks.some(task=>task.id===input.context)&&!c.items.some(item=>item.id===input.context))throw new V9Error('Choose an existing case, task or item conversation.');
  if(!input.deleted&&input.mentions.some(id=>!env.eligibleUser(id)))throw new V9Error('Choose active people from the directory.');
  const notes=c.notes??=[];
  if(input.id){
    const existing=notes.find(note=>note.id===input.id&&note.context===input.context);
    if(!existing||existing.deleted)throw new V9Error('Note not found.');
    if(existing.by!==env.actor.id)throw new V9Error('Only the author can edit or delete a note.','forbidden');
    if(!input.deleted&&!input.body.trim())throw new V9Error('Write a note before saving.');
    existing.revisions=[...(existing.revisions??[]),{body:existing.body,mentions:[...existing.mentions],deleted:existing.deleted,at:env.now,by:env.actor.id}];
    if(!input.deleted){existing.body=input.body.trim();existing.mentions=[...new Set(input.mentions)];}
    existing.deleted=!!input.deleted;existing.edited=true;
  }else{
    if(input.deleted||!input.body.trim())throw new V9Error('Write a note before sending.');
    if(notes.length>=5000)throw new V9Error('This case has reached its note limit.');
    notes.push({id:env.nextId(),context:input.context,body:input.body.trim(),by:env.actor.id,name:env.actor.name,at:env.now,mentions:[...new Set(input.mentions)],resolved:[],deleted:false,edited:false});
  }
  appendLog(c,env,input.deleted?'note.deleted':input.id?'note.edited':'note.added',input.context==='case'?'Case note updated.':'Work-item note updated.');
}
