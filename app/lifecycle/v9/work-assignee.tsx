'use client';
import type { Config } from '@/lib/lifecycle-v9-model';

export function WorkAssignee({name,group,assignee,config,users,busy,editable,change}:{name:string;group:string|null;assignee:string|null;config:Config;users:{id:string;name:string}[];busy:boolean;editable:boolean;change:(id:string)=>unknown}) {
  const members=users.filter(user=>config.groups.some(candidate=>candidate.id===group&&candidate.members.includes(user.id)));
  if(!editable||!group)return null;
  return <label className="v9-field"><span>{assignee?'Reassign':'Assign'}</span><select aria-label={`Assignee for ${name}`} value={assignee??''} disabled={busy||!members.length} onChange={event=>change(event.target.value)}><option value="" disabled>Unassigned</option>{assignee&&!members.some(user=>user.id===assignee)&&<option value={assignee} disabled>{users.find(user=>user.id===assignee)?.name??'Unavailable person'}</option>}{members.map(user=><option key={user.id} value={user.id}>{user.name}</option>)}</select></label>;
}
