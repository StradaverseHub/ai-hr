import { getTranslations } from 'next-intl/server';
import { requireOnehrAdminAccess } from '@/lib/authz';
import { PageHeader } from '@/components/ui';
import { getLeaderRoster, listCalibrationGroups, listHodAssignments, listLeaderSeats } from '@/packs/performance/service';
import { LeadersAdmin } from './leaders-admin';
import type { LeadersData } from './model';

/**
 * WP-B2 — Leaders: heads of department, business unit CEOs, business group CEOs and group chiefs. Guarded
 * like the cycle administration pages (OneHR administrators and the performance partner); every read is
 * fenced by RLS and every write is re-decided by the leader seat service. Write controls appear only where
 * the database's writer functions say this viewer may write.
 */
export default async function LeadersPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const s = await requireOnehrAdminAccess();
  const t = await getTranslations('onehr.leaders');
  const { tab } = await searchParams;
  const [roster, hods, seats, groups] = await Promise.all([
    getLeaderRoster(s),
    listHodAssignments(s, { liveOnly: true }),
    listLeaderSeats(s, { liveOnly: true }),
    listCalibrationGroups(s),
  ]);
  const data: LeadersData = {
    people: roster.people,
    companies: roster.companies,
    hods: hods.map((h) => ({ subjectEmploymentId: h.subjectEmploymentId, hodEmploymentId: h.hodEmploymentId, hodName: h.hodName })),
    seats: seats.map((x) => ({ id: x.id, seatType: x.seatType, companyId: x.companyId, calibrationGroupId: x.calibrationGroupId, holderEmploymentId: x.holderEmploymentId, holderName: x.holderName, holderEmployeeCode: x.holderEmployeeCode })),
    groups: groups.filter((g) => !g.retiredAt).map((g) => ({ id: g.id, name: g.name, members: g.members, chief: g.chief })),
    canWriteHod: roster.canWriteHod,
    canWriteGroupChief: roster.canWriteGroupChief,
  };
  const initialTab = tab === 'bu' || tab === 'bg' ? tab : 'hod';
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader back={{ href: '/performance', label: t('back') }} title={t('title')} description={t('description')} />
      <LeadersAdmin data={data} initialTab={initialTab} />
    </div>
  );
}
