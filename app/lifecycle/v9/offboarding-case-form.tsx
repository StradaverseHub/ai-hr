'use client';
import { useState } from 'react';
import { CaseFormFields } from '@/components/lifecycle-v9/case-form-fields';
import { resolveV9CaseFields, offCaseFormValues } from '@/lib/lifecycle-v9-case-form';
import type { Case, Config } from '@/lib/lifecycle-v9-model';
import type { LifecycleV9Command } from '@/packs/lifecycle/service';
export function OffboardingCaseForm({ c, config, users, busy, command }: { c: Case; config: Config; users: { id: string; name: string }[]; busy: boolean; command: (command: LifecycleV9Command) => Promise<{ ok: boolean; error?: string }> }) {
  const [values, setValues] = useState(()=>offCaseFormValues(c)), [editing,setEditing] = useState(c.state==='pending'), [reason,setReason] = useState(''), [error,setError] = useState('');
  const fields=resolveV9CaseFields('off',config.caseForms?.off), editable=['pending','submitted'].includes(c.state);
  async function save(submit=false) { setError(''); const result=await command({type:'caseFormSave',values:Object.fromEntries(Object.entries(values).filter(([key])=>fields.some(field=>field.key===key&&field.source==='case'))),reason,submit});if(result.ok)setEditing(false);else setError(result.error??'The case fields could not be saved.'); }
  return <div className="v9-stack">{error&&<p role="alert" className="v9-notice v9-error">{error}</p>}<CaseFormFields fields={fields} facts={c.facts} values={values} choices={{pbp:users}} display={{supervisor:users.find(user=>user.id===c.facts.supervisorUserId)?.name??'',lastDay:c.facts.lastDay.split('-').reverse().join('/')}} hr editing={editing} disabled={busy} change={(key,value)=>setValues(previous=>({...previous,[key]:value}))}/>{editing&&c.state==='submitted'&&<label className="v9-field"><span>Reason for changing case details</span><textarea rows={2} value={reason} onChange={e=>setReason(e.target.value)}/></label>}<div className="v9-actions">{editable&&!editing&&<button type="button" className="v9-button" onClick={()=>setEditing(true)}>Edit details</button>}{editable&&editing&&<><button type="button" className="v9-button" disabled={busy} onClick={()=>void save()}>Save</button>{c.state==='pending'&&<button type="button" className="v9-button v9-button-primary" disabled={busy} onClick={()=>void save(true)}>Submit case</button>}</>}</div></div>;
}
