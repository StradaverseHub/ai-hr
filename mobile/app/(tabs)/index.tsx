import { Fragment } from 'react';
import { useTenantDesign } from '../../lib/design';
/**
 * Home — task-first (the benchmark's best-rated pattern): what needs me, then my leave, then my pay.
 */
import { useApi } from '../../lib/api';
import { t } from '../../lib/i18n';
import { useSession } from '../../lib/session';
import { Card, LoadState, Muted, Row, Screen, SectionLabel, Title, fmtDays, fmtMoney } from '../../lib/ui';

export default function Home() {
  const { design } = useTenantDesign();
  const { signOut, employmentId } = useSession();
  const me = useApi('me', {}, signOut);
  const leave = useApi('leave', { employmentId: employmentId ?? undefined }, signOut);
  const payslips = useApi('payslips', {}, signOut);
  const inbox = useApi('notifications', {}, signOut);
  const reloadAll = () => [me, leave, payslips, inbox].forEach((l) => l.reload());

  const name = me.data?.person.name;
  const latest = payslips.data?.items[0];

  return (
    <Screen refreshing={me.loading && me.data != null} onRefresh={reloadAll}>
      <Title>{name ? t('hello', { name }) : t('helloNoName')}</Title>
      <LoadState loading={me.loading && !me.data} error={me.error} onRetry={me.reload} />

      {design.homeOrder.filter(id => id === 'tasks' || id === 'leave').map(id => <Fragment key={id}>
        {id === 'tasks' ? <><SectionLabel>{t('needsYou')}</SectionLabel><Card>
          {inbox.data?.enabled && inbox.data.unread > 0 ? <Row label={t('tabInbox')} value={t('unreadCount', { n: inbox.data.unread })} strong /> : <Muted>{t('nothingNeedsYou')}</Muted>}
        </Card></> : <><SectionLabel>{t('tabLeave')}</SectionLabel>
          <LoadState loading={leave.loading && !leave.data} error={leave.error} onRetry={leave.reload} />
          {leave.data?.cards.map(c => <Card key={c.leaveTypeId}><Row label={c.leaveType} value={fmtDays(c.takenOnly ? c.taken : c.isCurrentCycle ? c.canApplyFor : c.balance)} strong />{c.sharedPool && <Muted>{t('sharedPool')}</Muted>}</Card>)}
          {leave.data?.cards.length === 0 && <Muted>{t('noLeaveTypes')}</Muted>}
        </>}
      </Fragment>)}

      {me.data?.modules.payroll !== false && (
        <>
          <SectionLabel>{t('latestPayslip')}</SectionLabel>
          <LoadState loading={payslips.loading && !payslips.data} error={payslips.error} onRetry={payslips.reload} />
          {payslips.data && (
            <Card>
              {latest ? (
                <>
                  <Row label={latest.payPeriod} value={fmtMoney(latest.net)} strong />
                  <Muted>{t('netPay')}</Muted>
                </>
              ) : (
                <Muted>{t('noPayslips')}</Muted>
              )}
            </Card>
          )}
        </>
      )}
    </Screen>
  );
}
