'use client';
import { useState, type ReactNode } from 'react';
import type * as M from '@/lib/lifecycle-v9-model';
import { v9AddressRole, v9LiteralAddress } from '@/lib/lifecycle-v9-recipient';
const roles: [M.Role, string][] = [['employee', 'Employee'], ['supervisor', 'Line manager'], ['pbp', 'PBP'], ['ta', 'TA'], ['peopleOps', 'GBS People Ops'], ['taskOwners', 'Task owners'], ['hrSignatory', 'HR signatory'], ['starter', 'Whoever started it']];
function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="v9-field"><span>{label}</span>{children}</label>; }
export function RecipientPicker({ label, value, change, disabled, single = false, groups, users }: { label: string; value: M.Role[]; change: (value: M.Role[]) => void; disabled: boolean; single?: boolean; groups: M.Group[]; users: { id: string; name: string }[] }) {
  const [address, setAddress] = useState('');
  const literal = v9AddressRole(address);
  const roleName = (role: M.Role) => role.startsWith('address:') ? v9LiteralAddress(role) ?? 'Invalid email address' : role.startsWith('group:')
    ? groups.find(group => group.id === role.slice(6))?.name ?? 'Unavailable group'
    : role.startsWith('person:')
      ? users.find(user => user.id === role.slice(7))?.name ?? 'Unavailable person'
      : roles.find(([key]) => key === role)?.[1] ?? 'Unavailable role';
  const full = !single && value.length >= 8;
  const select = (role: M.Role) => { if (!full || value.includes(role)) change(single ? [role] : value.includes(role) ? value : [...value, role]); };
  return <details className="v9-recipient-picker">
    <summary role="button" aria-label={label}>{label.startsWith('CC') ? 'CC' : 'To'}: {value.map(roleName).join(', ') || 'No one'}</summary>
    <fieldset className="v9-role-picker"><legend>{label}</legend><div className="v9-stack">
      {roles.filter(([role]) => single || role !== 'taskOwners').map(([role, name]) => <label key={role}>
        <input type="checkbox" checked={value.includes(role)} disabled={disabled || full && !value.includes(role)} onChange={event => event.target.checked ? select(role) : change(value.filter(selected => selected !== role))}/>{name}
      </label>)}
      {value.filter(role => role.startsWith('group:') || role.startsWith('person:') || role.startsWith('address:')).map(role => <label key={role}>
        <input type="checkbox" checked disabled={disabled} onChange={() => change(value.filter(selected => selected !== role))}/>{role.startsWith('group:') ? 'Group: ' : role.startsWith('address:') ? 'Email: ' : 'Person: '}{roleName(role)}
      </label>)}
      <Field label="An assignment group"><select aria-label={`Assignment group for ${label}`} value="" disabled={disabled || full} onChange={event => { if (event.target.value) select(`group:${event.target.value}`); }}>
        <option value="">Choose a group…</option>{groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
      </select></Field>
      <Field label="A named person"><select aria-label={`Named person for ${label}`} value="" disabled={disabled || full} onChange={event => { if (event.target.value) select(`person:${event.target.value}`); }}>
        <option value="">Choose a person…</option>{users.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}
      </select></Field>
      <Field label="An email address"><input className="v9-input" type="email" aria-label={`Email address for ${label}`} value={address} disabled={disabled || full} maxLength={254} onChange={event => setAddress(event.target.value)}/></Field>
      <button type="button" className="v9-button" disabled={disabled || full || !literal} onClick={() => { if (literal) { select(literal); setAddress(''); } }}>Add email address</button>
    </div></fieldset>
  </details>;
}
