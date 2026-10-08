import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { listCompanies } from '@/core/read';
import { listLocations } from '@/core/location';
import { Card, PageHeader, SectionHeader, btnGhost, pageWideCls } from '@/components/ui';
import { workLocationsReturnTo, withWorkLocationsFrom } from '@/lib/return-to';
import { UUID_RE, locationEditPage } from '../location-fields';

/**
 * 639bf4a5 rev 2 (r338) — VIEW one work location, on a screen of its own. Read-only, by design: the
 * reporter asked for Add, View and Edit to each open their own screen, and a View that quietly carried
 * editable boxes would be the Edit screen under another name.
 *
 * Opened by the "View" link on the company listing. Back returns to the listing, carrying the query it
 * was left on (`?from=`, whitelisted by shape — lib/return-to.ts). Edit is offered from here too, so a
 * reader who decides to change something does not have to go back and pick again.
 *
 * ⚠️ `[id]` IS AN UNTRUSTED URL SEGMENT AND `location.id` IS A UUID COLUMN. Its shape is checked BEFORE
 * any query (junk reaching `eq(location.id, …)` makes Postgres throw "invalid input syntax for type
 * uuid" — the r263 verifier's 500). Junk and an unknown id are both notFound().
 *
 * SCOPE IS THE QUERY. The location is looked for among the ones belonging to the companies
 * `listCompanies(s, { adminOnly: true })` returned, so a location in a company this admin does not
 * administer is notFound() rather than rendered — the same boundary the listing draws, drawn again here
 * rather than trusted from the link that got us here.
 *
 * r423 (83c0d3c8) — NO CLOCKING LOCATIONS HERE ANY MORE. They render beside the location they hung off
 * from r338 until r423; Attendance › Locations (../clocking/page.tsx) is now the one list of clocking
 * locations, and a work location is what it always was — where an employee works.
 */
export default async function ViewLocationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.locations');
  const { id: rawId } = await params;
  const sp = await searchParams;
  if (!UUID_RE.test(rawId)) notFound();

  const backHref = workLocationsReturnTo(sp.from);
  const companies = await listCompanies(s, { adminOnly: true });
  const locations = await listLocations(s, companies.map((c) => c.id), { includeArchived: true });
  const site = locations.find((l) => l.id === rawId);
  if (!site) notFound();

  const facts: [string, string][] = [
    [t('colCompany'), site.companyName],
    [t('code'), site.code],
    [t('name'), site.name],
    [t('country'), site.country],
    [t('branch'), site.branch ?? t('branchNone')],
    [t('headcount'), t('headcountLabel', { count: site.headcount })],
    [t('colStatus'), site.archivedAt ? t('statusArchived') : t('statusActive')],
  ];

  return (
    <div className={pageWideCls}>
      <PageHeader
        title={t('viewLocationTitle')}
        description={`${site.code} · ${site.name}`}
        back={{ href: backHref, label: t('backToWorkLocations') }}
        actions={
          <Link href={withWorkLocationsFrom(locationEditPage(site.id), backHref)} className={btnGhost}>
            {t('edit')}
          </Link>
        }
      />

      <Card>
        <SectionHeader title={t('sectionSite')} />
        <dl className="grid gap-4 p-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
          {facts.map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
              <dd className="mt-1">{value}</dd>
            </div>
          ))}
        </dl>
      </Card>

    </div>
  );
}
