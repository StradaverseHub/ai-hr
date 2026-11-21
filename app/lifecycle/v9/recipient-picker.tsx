'use client';
import { useState, type ReactNode } from 'react';
import type * as M from '@/lib/lifecycle-v9-model';
import { v9AddressRole, v9LiteralAddress } from '@/lib/lifecycle-v9-recipient';
import { MAX_RECIPIENT_CHOICES, isRemovedRole, legacyEmployeeRole, offeredRoles, roleLabel } from '@/lib/lifecycle-v9-recipients';
function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="v9-field"><span>{label}</span>{children}</label>; }
/** Board 4a60b3ec: the same choices for To and CC, in onboarding and offboarding (TA only in onboarding).
 * Removed roles saved earlier stay visible with "Replace recipient" and can only be taken out. */
export function RecipientPicker({ label, value, change, disabled, groups, users, module = 'off' }: { label: string; value: M.Role[]; change: (value: M.Role[]) => void; disabled: boolean; groups: M.Group[]; users: { id: string; name: string }[]; module?: M.Module; single?: boolean }) {
  const [address, setAddress] = useState('');
  const literal = v9AddressRole(address);
  const names = { group: (id: string) => groups.find(group => group.id === id)?.name, person: (id: string) => users.find(user => user.id === id)?.name };
  const roleName = (role: M.Role) => role.startsWith('address:') ? v9LiteralAddress(role) ?? 'Invalid email address' : roleLabel(role, names);
  const full = value.length >= MAX_RECIPIENT_CHOICES;
  const select = (role: M.Role) => { if (!value.includes(role) && !full) change([...value, role]); };
  const offered = offeredRoles(module), flagged = value.filter(role => isRemovedRole(role) || role === legacyEmployeeRole || role === 'ta' && module !== 'onb');
  return <details className="v9-recipient-picker">
    <summary role="button" aria-label={label}>{label.startsWith('CC') ? 'CC' : 'To'}: {value.map(roleName).join(', ') || 'No one'}{flagged.length ? ' · Replace recipient' : ''}</summary>
    <fieldset className="v9-role-picker"><legend>{label}</legend><div className="v9-stack">
      {flagged.map(role => <div key={role} role="alert" className="v9-notice v9-warning" data-replace-recipient={role}>
        <strong>Replace recipient:</strong> {roleName(role)} {role === legacyEmployeeRole ? 'is no longer offered. Choose the work or personal email instead.' : 'can no longer be chosen. Until it is replaced, this email is held whenever it finds nobody.'}
        <button type="button" className="v9-button" disabled={disabled} onClick={() => change(value.filter(selected => selected !== role))}>Remove {roleName(role)}</button>
      </div>)}
      {offered.map(role => <label key={role}>
        <input type="checkbox" checked={value.includes(role)} disabled={disabled || full && !value.includes(role)} onChange={event => event.target.checked ? select(role) : change(value.filter(selected => selected !== role))}/>{roleName(role)}
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
      {full && <p className="v9-muted">Up to {MAX_RECIPIENT_CHOICES} choices.</p>}
    </div></fieldset>
  </details>;
}
