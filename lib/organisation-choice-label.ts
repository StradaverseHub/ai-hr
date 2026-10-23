/** Display only. A caller must supply its already-authorized catalogue; identifiers never change. */
export type OrganisationChoice = {
  id?: string;
  value?: string;
  code?: string | null;
  label?: string | null;
  description?: string | null;
  name?: string | null;
  title?: string | null;
};

const text = (value: string | null | undefined) => value?.trim() || '';

export function organisationChoiceLabel(row: OrganisationChoice): string {
  return text(row.label) || text(row.description) || text(row.name) || text(row.title) || text(row.code) || text(row.value);
}

/** Qualify only collisions in the supplied scope, preserving input order and every original value. */
export function organisationChoiceLabels<T extends OrganisationChoice>(rows: readonly T[]): (T & { displayLabel: string })[] {
  const labels = rows.map(organisationChoiceLabel);
  const counts = new Map<string, number>();
  for (const label of labels) {
    const key = label.toLocaleLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const identifiers = rows.map(row => text(row.code) || text(row.value) || text(row.id));
  const qualified = rows.map((row, index) => {
    const label = labels[index];
    const identifier = identifiers[index];
    const duplicate = (counts.get(label.toLocaleLowerCase()) ?? 0) > 1;
    return duplicate && identifier ? `${label} (${identifier})` : label;
  });
  const qualifiedCounts = new Map<string, number>();
  for (const label of qualified) {
    const key = label.toLocaleLowerCase();
    qualifiedCounts.set(key, (qualifiedCounts.get(key) ?? 0) + 1);
  }
  return rows.map((row, index) => {
    const label = qualified[index];
    const id = text(row.id) || text(row.value);
    const stillAmbiguous = (qualifiedCounts.get(label.toLocaleLowerCase()) ?? 0) > 1;
    return { ...row, displayLabel: stillAmbiguous && id && id !== identifiers[index] ? `${label} · ${id}` : label };
  });
}

/** A filter offers only organisation identities present in its already-authorized employee set. */
export function organisationFilterChoices(rows: readonly {id: string | null; name: string | null; code?: string | null}[]): {id:string;name:string}[] {
  const unique = new Map<string,{id:string;name:string;code?:string|null}>();
  for (const row of rows) if (row.id && row.name?.trim()) unique.set(row.id,{...row,id:row.id,name:row.name});
  return organisationChoiceLabels([...unique.values()]).map(row=>({id:row.id,name:row.displayLabel})).sort((a,b)=>a.name.localeCompare(b.name));
}
