/** Server-only leaf. A preview binds fresh owner data; it never replaces authorization at commit. */
import {createHash} from 'node:crypto';
import type {AccessCapability,AccessSnapshot} from './access-permission-model';
import {isAccessConfigurationCommand,type AccessConfigurationCommand} from './access-configuration-command';
import {AccessPermissionError} from './access-permission-model';

function canonical(value:unknown):unknown{
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)]));
  return value;
}
const ordered=<T>(rows:readonly T[])=>rows.map(row=>canonical(row)).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
function canonicalSnapshot(snapshot:AccessSnapshot){
  return {...snapshot,users:ordered(snapshot.users),memberships:ordered(snapshot.memberships),overrides:ordered(snapshot.overrides),groups:ordered(snapshot.groups.map(group=>({...group,grants:ordered(group.grants)})))};
}
export type AccessPreviewBinding={
  actorUserId:string;
  snapshot:AccessSnapshot;
  catalog:readonly AccessCapability[];
  command:AccessConfigurationCommand;
  /** Hash of the actual dated company coverage and relevant subject availability, loaded by the owner. */
  scopeFingerprint:string;
};
export function accessPreviewFingerprint(binding:AccessPreviewBinding):string{
  if(!binding.actorUserId||!/^[a-f0-9]{64}$/.test(binding.scopeFingerprint)||!isAccessConfigurationCommand(binding.command))throw new AccessPermissionError('invalid');
  const command=binding.command.kind==='replaceGroupGrants'?{...binding.command,grants:ordered(binding.command.grants)}:binding.command;
  const catalog=ordered(binding.catalog.map(capability=>({...capability,bindings:ordered(capability.bindings)})));
  return createHash('sha256').update(JSON.stringify(canonical({version:1,actorUserId:binding.actorUserId,snapshot:canonicalSnapshot(binding.snapshot),catalog,command,scopeFingerprint:binding.scopeFingerprint}))).digest('hex');
}
/** Recompute under the same access lock as the mutation, after fresh actor/ceiling checks. */
export function assertAccessPreviewCurrent(binding:AccessPreviewBinding,submitted:unknown){
  if(typeof submitted!=='string'||!/^[a-f0-9]{64}$/.test(submitted)||submitted!==accessPreviewFingerprint(binding))throw new AccessPermissionError('changed');
}
