/** Canonical draft/materialisation key. Government identifiers refine import matching separately. */
export type DependentIdentity={fullName:string;relationship:string;dateOfBirth?:string|null;icOrPassport?:string|null;passportNumber?:string|null};
export function dependentNaturalKey(row:DependentIdentity):string {
  return `${row.fullName.trim().replace(/\s+/g,' ').toLowerCase()}\u0000${row.relationship.trim()}\u0000${(row.dateOfBirth??'').trim()}`;
}
/** A repeated file may skip a proven match; uncertain identity must be reviewed, never dropped. */
export function dependentImportMatch(existing:readonly DependentIdentity[],incoming:DependentIdentity):'new'|'existing'|'ambiguous' {
  const candidates=existing.filter(row=>dependentNaturalKey(row)===dependentNaturalKey(incoming));
  if(!candidates.length)return 'new';
  const fields=['icOrPassport','passportNumber'] as const;
  const norm=(value:string|null|undefined)=>(value??'').trim().toUpperCase();
  const hasId=fields.some(field=>norm(incoming[field]));
  if(!hasId)return candidates.length===1 && !fields.some(field=>norm(candidates[0][field]))?'existing':'ambiguous';
  let unresolved=false;
  for(const candidate of candidates) {
    const shared=fields.filter(field=>norm(incoming[field]) && norm(candidate[field]));
    const matches=shared.filter(field=>norm(incoming[field])===norm(candidate[field]));
    const conflicts=shared.filter(field=>norm(incoming[field])!==norm(candidate[field]));
    if(matches.length && conflicts.length)return 'ambiguous';
    if(matches.length)return 'existing';
    if(!conflicts.length)unresolved=true;
  }
  return unresolved?'ambiguous':'new';
}
