/**
 * My leave — the web dashboard's card fronts, figure for figure (GET /api/mobile/v1/leave).
 */
import { Text } from 'react-native';
import { useApi } from '../../lib/api';
import { t } from '../../lib/i18n';
import { useSession } from '../../lib/session';
import { Card, LoadState, Muted, Row, Screen, Title, colors, fmtDays } from '../../lib/ui';

export default function Leave() {
  const { signOut, employmentId } = useSession();
  const leave = useApi('leave', { employmentId: employmentId ?? undefined }, signOut);
  return (
    <Screen refreshing={leave.loading && leave.data != null} onRefresh={leave.reload}>
      <Title>{t('tabLeave')}</Title>
      <LoadState loading={leave.loading && !leave.data} error={leave.error} onRetry={leave.reload} />
      {leave.data?.cards.length === 0 && <Muted>{t('noLeaveTypes')}</Muted>}
      {leave.data?.cards.map((c) => (
        <Card key={c.leaveTypeId}>
          <Text style={{ fontSize: 17, fontWeight: '600', color: c.color ?? colors.text }}>{c.leaveType}</Text>
          {c.takenOnly ? (
            <Row label={t('taken')} value={fmtDays(c.taken)} strong />
          ) : (
            <>
              {c.isCurrentCycle && c.canApplyFor != null && (
                <Row label={t('canApplyFor')} value={fmtDays(c.canApplyFor)} strong />
              )}
              <Row label={t('balance')} value={fmtDays(c.balance)} />
              <Row label={t('taken')} value={fmtDays(c.taken)} />
              {c.pending != null && c.pending > 0 && <Row label={t('pending')} value={fmtDays(c.pending)} />}
            </>
          )}
          {c.sharedPool && <Muted>{t('sharedPool')}</Muted>}
        </Card>
      ))}
    </Screen>
  );
}
