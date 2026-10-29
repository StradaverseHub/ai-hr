import { useTenantDesign } from '../../lib/design';
/**
 * Me — who I am, which employment I am acting as (the picker, when there is more than one), then plain rows: payslips
 * and EA forms, my attendance, my profile, my leave history; and "This phone": shift reminders, notifications, device
 * registration, saved submissions and sign out.
 *
 * M09 — the v1 totals widget is gone from this screen: payslips open on their own screen (app/pay, v2), every
 * employment, natively. GET /api/mobile/v1/payslips stays for installed clients; this build no longer reads it.
 */
import { useEffect, useRef } from 'react';
import { Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { companyCopy, useCompanyConnection } from '../../lib/company-connection';
import { DesignText as Text } from '../../lib/design';
import { useApi } from '../../lib/api';
import { t } from '../../lib/i18n';
import { useSession } from '../../lib/session';
import { useQueuedOfflinePunches } from '../../lib/offline-clock';
import { PushPrompt, ShiftReminderSetting } from '../../lib/push';
import { Card, ListRow, LoadState, Muted, Screen, SectionLabel, Title } from '../../lib/ui';

export default function Me() {
  const company=useCompanyConnection();
  const { palette } = useTenantDesign();
  const { signOut, employmentId, setEmploymentId, status } = useSession();
  const signedIn = useRef(status === 'signedIn'); signedIn.current = status === 'signedIn';
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // Offline punches stay on this phone across sign-out; shown as information beside Sign out, never as a blocker.
  const queued = useQueuedOfflinePunches(() => mounted.current && signedIn.current);
  const me = useApi('me', {}, signOut);
  const employments = me.data?.employments ?? [];
  const active = employmentId ?? employments[0]?.employmentId ?? null;

  return (
    <Screen refreshing={me.loading && me.data != null} onRefresh={me.reload}>
      <Title>{me.data?.person.name ?? t('tabMe')}</Title>
      {me.data?.person.email && <Muted>{me.data.person.email}</Muted>}
      <LoadState loading={me.loading} hasData={me.data!=null} error={me.error} onRetry={me.reload} />

      {employments.length > 0 && <SectionLabel>{t('employments')}</SectionLabel>}
      {employments.map((e) => (
        <Pressable
          key={e.employmentId}
          disabled={employments.length < 2}
          onPress={() => setEmploymentId(e.employmentId)}
          accessibilityRole={employments.length > 1 ? 'radio' : undefined}
          accessibilityState={{ selected: e.employmentId === active }}
        >
          <Card>
            <Text style={{ fontSize: 16, fontWeight: e.employmentId === active ? '700' : '400', color: palette.text }}>
              {e.company}
            </Text>
            {(e.position || e.department) && <Muted>{[e.position, e.department].filter(Boolean).join(' · ')}</Muted>}
          </Card>
        </Pressable>
      ))}

      {/* Plain rows: my records first, then what belongs to this phone. Expense claims are web-only now. */}
      <View>
        <ListRow label={t('payOpen')} onPress={() => router.push('/pay')} />
        <ListRow label={t('attOpen')} onPress={() => router.push('/attendance')} />
        <ListRow label={t('profileOpen')} onPress={() => router.push('/profile')} />
        <ListRow label={t('meLeaveHistory')} onPress={() => router.push('/leave/history')} />
      </View>

      <SectionLabel>{t('meSectionDevice')}</SectionLabel>
      <ShiftReminderSetting />
      <PushPrompt />
      <View>
        <ListRow label={t('integrityKeysTitle')} onPress={() => router.push('/integrity-keys')} />
        <ListRow label={t('pendingTitle')} onPress={() => router.push('/pending-submissions')} />
        {company && <ListRow label={companyCopy().change} onPress={() => router.push({ pathname: '/pending-submissions', params: { intent: 'company' } })} />}
        <ListRow label={t('signOut')} onPress={() => router.push({ pathname: '/pending-submissions', params: { intent: 'logout' } })} />
      </View>
      {queued > 0 && <Muted>{t(queued === 1 ? 'offlineSignOutNoteOne' : 'offlineSignOutNote', { n: queued })}</Muted>}
    </Screen>
  );
}
