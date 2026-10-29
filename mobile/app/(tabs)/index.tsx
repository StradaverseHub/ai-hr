import { ComposedPage } from '../../lib/composed-page';
import { ClockSummary, LeaveSummary, PayslipRow } from '../../lib/home-cards';
import { HomeNeeds } from '../../lib/inbox';
import { TeamPanel } from '../../lib/team-panel';
import { Fragment, useState } from 'react';
import { useTenantDesign } from '../../lib/design';
/**
 * Home — a summary, task-first: today's clock status (the card opens the Clock tab; Home never clocks), what needs me
 * (two rows: approvals, unread), at most three leave balances and "All balances", who's away, the latest payslip as
 * one row. Disclaimers and attempt reports stay on the Clock tab. "Needs you" is M14's truthful card
 * (mobile/lib/inbox.tsx HomeNeeds): never "nothing needs you" while a count is loading or failed.
 */
import { useApi } from '../../lib/api';
import { t } from '../../lib/i18n';
import { useSession } from '../../lib/session';
import { LoadState, Screen, SectionLabel, Title } from '../../lib/ui';

export default function Home() {
  const { design } = useTenantDesign();
  return design.schemaVersion === 2 ? <ComposedPage design={design} /> : <LegacyHome />;
}
/** A tenant that never customised (schema 1): the published section order, each section in its summary form. */
function LegacyHome() {
  const { design } = useTenantDesign();
  const { signOut } = useSession();
  const me = useApi('me', {}, signOut);
  const [refreshToken, setRefreshToken] = useState(0);
  const reloadAll = () => { me.reload(); setRefreshToken(n => n + 1); };
  const name = me.data?.person.name;

  return (
    <Screen refreshing={me.loading && me.data != null} onRefresh={reloadAll}>
      <Title>{name ? t('hello', { name }) : t('helloNoName')}</Title>
      <LoadState loading={me.loading} hasData={me.data != null} error={me.error} onRetry={me.reload} />
      {design.homeOrder.map(id => <Fragment key={id}>
        {id === 'clock' ? <ClockSummary refreshToken={refreshToken} />
          : id === 'team' ? <TeamPanel refreshToken={refreshToken} compact />
          : id === 'tasks' ? <><SectionLabel>{t('needsYou')}</SectionLabel><HomeNeeds refreshToken={refreshToken} /></>
          : <><SectionLabel>{t('tabLeave')}</SectionLabel><LeaveSummary refreshToken={refreshToken} /></>}
      </Fragment>)}
      {me.data?.modules.payroll !== false && <><SectionLabel>{t('payslips')}</SectionLabel><PayslipRow refreshToken={refreshToken} /></>}
    </Screen>
  );
}
