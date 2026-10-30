import { matchChecklist, taskDate, type Case, type Config } from '@/lib/lifecycle-v9-model';
const date=(value:string)=>value?value.split('-').reverse().join('/'):'—';
/** Presentation only: assignment and the immutable checklist snapshot begin at submission. */
export function ChecklistPreview({c,config}:{c:Case;config:Config}) {
  const {checklist,tie}=matchChecklist(config,c);
  return <div className="v9-stack">{tie&&<p className="v9-notice v9-warning">More than one checklist matches at the same specificity. Display order selects the first; review your choice before submission.</p>}
    <p className="v9-muted">{checklist?checklist.name:'No checklist selected'} · Preview</p><ul className="v9-list">{checklist?.tasks.map(task=><li key={task.id}><div className="v9-heading"><div><strong>{task.name}{task.required?' *':''}</strong><div className="v9-muted">{task.by==='employee'?'Employee':task.by==='manager'?'Supervisor':config.groups.find(group=>group.id===task.group)?.name??'Unassigned group'} · Due {date(taskDate(c.module,c.module==='off'?c.facts.lastDay:c.facts.joinDate,task.due))}{task.opens!==null?' · Opens '+date(taskDate(c.module,c.module==='off'?c.facts.lastDay:c.facts.joinDate,task.opens)):''}</div></div><span className="v9-badge">Preview</span></div></li>)}</ul>
    {!checklist?.tasks.length&&<p className="v9-muted">No checklist tasks in this choice.</p>}
    <p className="v9-muted">The checklist and assignment owners are confirmed when you submit the case.</p>
  </div>;
}
