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
import { Material,alpha } from '../../lib/visual';
import { initials, tint } from '../../lib/home-hero';
import { t, type MessageKey } from '../../lib/i18n';
import { useSession } from '../../lib/session';
import { Card, LoadState, Muted, Screen, SectionLabel, Title } from '../../lib/ui';

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
    <Screen atmospheric refreshing={me.loading && me.data != null} onRefresh={me.reload}>
      <View style={{flexDirection:'row',alignItems:'center',justifyContent:'space-between'}}><Title>{t('tabMe')}</Title><Pressable accessibilityRole="button" accessibilityLabel={t('qaSettings')} onPress={()=>router.push('/settings')} style={{width:44,height:44,alignItems:'center',justifyContent:'center',borderRadius:22,backgroundColor:alpha(palette.text,.08)}}><Icon name="settings" color={palette.text} size={21}/></Pressable></View>
      <View style={{ alignItems: 'center', gap: 12, paddingTop: 12, paddingBottom: 20 }}>
        <Material style={{width:94,height:94,borderRadius:34,alignItems:'center',justifyContent:'center',experimental_backgroundImage:`linear-gradient(145deg, ${alpha(palette.accent,.25)} 0%, transparent 75%)`}}><Text style={{color:palette.text,fontSize:34,fontWeight:'500'}}>{initials(me.data?.person.name)}</Text></Material>
        <Text accessibilityRole="header" style={{color:palette.text,fontSize:28,fontWeight:'600',letterSpacing:-.6,textAlign:'center'}}>{me.data?.person.name??t('tabMe')}</Text>
        {current&&<Text style={{color:palette.muted,fontSize:14,lineHeight:21,textAlign:'center'}}>{[current.position,current.company].filter(Boolean).join(' · ')}</Text>}
        {me.data?.person.email&&<Text style={{color:palette.muted,fontSize:13,textAlign:'center'}}>{me.data.person.email}</Text>}
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
  return <Material style={{ borderRadius: radius, overflow: 'hidden' }}>
    {items.map((it, i) => <Pressable key={it.label} accessibilityRole="button" accessibilityLabel={t(it.label)} onPress={() => router.push(it.href)}
      style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 60, paddingHorizontal: 16, borderTopWidth: i ? 1 : 0, borderColor: palette.border }, pressed && { backgroundColor: tint(palette.accent, 0.06, palette.bg) }]}>
      <View style={{ width: 32, height: 32, borderRadius: 9, backgroundColor: 'transparent', alignItems: 'center', justifyContent: 'center' }}><Icon name={it.icon} color={palette.accent} size={17} /></View>
      <Text style={{ color: palette.text, fontSize: 16, flex: 1 }}>{t(it.label)}</Text>
      <Icon name="chevron" color={palette.muted} size={13} />
    </Pressable>)}
  </Material>;
}
