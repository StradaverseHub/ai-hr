/**
 * Me — who I am (avatar, name, email), which employment I am acting as (the picker, when there is more than one),
 * then one list of everything that is mine: profile, payslips and EA forms, attendance, overtime plans, leave history,
 * team calendar, staff directory and approvals; and Settings, where this phone's things now live (app lock,
 * screenshot protection, notifications, device registration, saved submissions, sign out).
 *
 * M09 — payslips open on their own screen (app/pay, v2), every employment, natively.
 */
import { Pressable, View } from 'react-native';
import { router, type Href } from 'expo-router';
import { DesignText as Text, useTenantDesign } from '../../lib/design';
import { useApi } from '../../lib/api';
import { Icon, type IconName } from '../../lib/icon';
import { initials, tint } from '../../lib/home-hero';
import { t, type MessageKey } from '../../lib/i18n';
import { useSession } from '../../lib/session';
import { Card, LoadState, Muted, Screen, SectionLabel } from '../../lib/ui';

type Item = { icon: IconName; label: MessageKey; href: Href };

export default function Me() {
  const { palette } = useTenantDesign();
  const { signOut, employmentId, setEmploymentId } = useSession();
  const me = useApi('me', {}, signOut);
  const employments = me.data?.employments ?? [];
  const active = employmentId ?? employments[0]?.employmentId ?? null;
  const current = employments.find((e) => e.employmentId === active);
  const payroll = me.data?.modules.payroll !== false;
  const mine: Item[] = [
    { icon: 'profile', label: 'profileOpen', href: '/profile' },
    ...(payroll ? [{ icon: 'payslip', label: 'payOpen', href: '/pay' } as const] : []),
    { icon: 'attendance', label: 'attOpen', href: '/attendance' },
    { icon: 'overtime', label: 'qaOtPlan', href: '/attendance/ot-plan' },
    { icon: 'leave', label: 'meLeaveHistory', href: '/leave/history' },
  ];
  const team: Item[] = [
    { icon: 'approvals', label: 'qaApprovals', href: '/approvals' },
    { icon: 'teamCalendar', label: 'qaTeamCalendar', href: '/team-calendar' },
    { icon: 'directory', label: 'qaDirectory', href: '/directory' },
  ];

  return (
    <Screen refreshing={me.loading && me.data != null} onRefresh={me.reload}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16, paddingVertical: 4 }}>
        <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: palette.button, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ color: palette.onButton, fontSize: 24, fontWeight: '800' }}>{initials(me.data?.person.name)}</Text>
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text accessibilityRole="header" style={{ color: palette.text, fontSize: 24, fontWeight: '800' }}>{me.data?.person.name ?? t('tabMe')}</Text>
          {current && <Text numberOfLines={1} style={{ color: palette.muted, fontSize: 14 }}>{[current.position, current.company].filter(Boolean).join(' · ')}</Text>}
          {me.data?.person.email && <Text numberOfLines={1} style={{ color: palette.muted, fontSize: 13 }}>{me.data.person.email}</Text>}
        </View>
      </View>
      <LoadState loading={me.loading} hasData={me.data != null} error={me.error} onRetry={me.reload} />

      {employments.length > 1 && <>
        <SectionLabel>{t('employments')}</SectionLabel>
        {employments.map((e) => (
          <Pressable key={e.employmentId} onPress={() => setEmploymentId(e.employmentId)} accessibilityRole="radio" accessibilityState={{ selected: e.employmentId === active }}>
            <Card>
              <Text style={{ fontSize: 16, fontWeight: e.employmentId === active ? '700' : '400', color: palette.text }}>{e.company}</Text>
              {(e.position || e.department) && <Muted>{[e.position, e.department].filter(Boolean).join(' · ')}</Muted>}
            </Card>
          </Pressable>
        ))}
      </>}

      <SectionLabel>{t('meSectionMine')}</SectionLabel>
      <Group items={mine} />
      <SectionLabel>{t('meSectionTeam')}</SectionLabel>
      <Group items={team} />
      <SectionLabel>{t('meSectionApp')}</SectionLabel>
      <Group items={[{ icon: 'settings', label: 'qaSettings', href: '/settings' }]} />
    </Screen>
  );
}

function Group({ items }: { items: readonly Item[] }) {
  const { palette, design } = useTenantDesign();
  const radius = design.schemaVersion === 2 ? design.composition.layout.radius : design.corners === 'soft' ? 18 : 4;
  return <View style={{ borderRadius: radius, backgroundColor: palette.card, borderWidth: 1, borderColor: palette.border, overflow: 'hidden' }}>
    {items.map((it, i) => <Pressable key={it.label} accessibilityRole="button" accessibilityLabel={t(it.label)} onPress={() => router.push(it.href)}
      style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 56, paddingHorizontal: 16, borderTopWidth: i ? 1 : 0, borderColor: palette.border }, pressed && { backgroundColor: tint(palette.accent, 0.06, palette.bg) }]}>
      <View style={{ width: 32, height: 32, borderRadius: 9, backgroundColor: tint(palette.accent, 0.12, palette.bg), alignItems: 'center', justifyContent: 'center' }}><Icon name={it.icon} color={palette.accent} size={17} /></View>
      <Text style={{ color: palette.text, fontSize: 16, flex: 1 }}>{t(it.label)}</Text>
      <Icon name="chevron" color={palette.muted} size={13} />
    </Pressable>)}
  </View>;
}
