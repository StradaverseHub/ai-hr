import { listDepartments, personnelFilterChoices } from '@/core/read';
import { PersonnelReadBusyError } from '@/core/personnel-read-bounds';
import { organisationChoiceLabels } from '@/lib/organisation-choice-label';
import { requireWorkforceAccess } from '@/lib/workforce-authz';

function distinctOptions(items: { value: string | null; label: string | null }[]) {
  const options = [...new Map(items
    .filter((item): item is { value: string; label: string } => !!item.value && !!item.label)
    .map(item => [item.value, item])).values()];
  const counts = new Map<string, number>();
  for (const { label } of options) counts.set(label, (counts.get(label) ?? 0) + 1);
  return options.map(item => ({
    ...item,
    label: (counts.get(item.label) ?? 0) > 1 ? item.label + ' · ' + item.value.slice(0, 8) : item.label,
  })).sort((a, b) => a.label.localeCompare(b.label));
}

export async function GET() {
  const headers = { 'Cache-Control': 'private, no-store' };
  try {
    const { s, scopeIds } = await requireWorkforceAccess({ personnelList: true });
    const { companies, rows, canInspectDuplicates } = await personnelFilterChoices(s, scopeIds);
    const departments = scopeIds.length ? await listDepartments(s, { companyIds: scopeIds }) : [];
    return Response.json({
      companies,
      canInspectDuplicates,
      options: {
        dept: organisationChoiceLabels(departments).map(d => ({ value: d.id, label: d.displayLabel })),
        bu: distinctOptions([
          ...companies.map(c => ({ value: c.businessUnitId, label: c.businessUnit })),
          ...rows.map(row => ({ value: row.businessUnitId, label: row.businessUnit })),
        ]),
        parent: distinctOptions(companies.map(c => ({ value: c.parentCompanyId, label: c.parentCompany }))),
        group: distinctOptions(companies.map(c => ({ value: c.businessGroupId, label: c.businessGroup }))),
        position: distinctOptions(rows.map(row => ({ value: row.positionId, label: row.position }))),
      },
    }, { headers });
  } catch (error) {
    if (!(error instanceof PersonnelReadBusyError)) throw error;
    return new Response(null, { status: 503, headers: { ...headers, 'Retry-After': '5' } });
  }
}
