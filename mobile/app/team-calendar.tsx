/**
 * Team calendar — a month of who is away, from the same v2 team window as Home's "Who's away" (M13). Membership, dates,
 * sessions and approved-vs-pending are the server's (My Team's own scope); the app only chooses which month to ask for
 * (one read, at most TEAM_WINDOW_MAX_DAYS days). No leave type or reason is ever received. The grid starts weeks on
 * Monday for layout only; it makes no claim about the company's working week.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { DesignText as Text, useTenantDesign } from '../lib/design';
import { useApiV2 } from '../lib/api';
import { fmtCalendarDate, fmtMonth } from '../lib/attendance-format';
import { initials, tint } from '../lib/home-hero';
import { t } from '../lib/i18n';
import { useSession } from '../lib/session';
import { Card, LoadState, Muted, Screen, Title } from '../lib/ui';
import { TeamAvailabilityV2 } from '../../lib/mobile-api/v2/team';

const pad = (n: number) => String(n).padStart(2, '0');
/** `YYYY-MM` plus `delta` months. */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}
/** Every date of `YYYY-MM`, and how many blank cells precede the 1st in a Monday-first grid. */
export function monthGrid(month: string): { dates: string[]; lead: number } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lead = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
  return { dates: Array.from({ length: days }, (_, i) => `${month}-${pad(i + 1)}`), lead };
}

export default function TeamCalendar() {
  const { palette } = useTenantDesign();
  const { signOut } = useSession();
  const [month, setMonth] = useState<string | null>(null);
  const grid = month ? monthGrid(month) : null;
  const team = useApiV2('v2/team/availability', TeamAvailabilityV2, grid ? { from: grid.dates[0], to: grid.dates[grid.dates.length - 1] } : {}, signOut);
  useFocusEffect(useCallback(() => { team.reload(); }, [team.reload]));
  const data = team.data;
  // The first read (no window) is the server's default; its `today` anchors the month the app then asks for.
  const shown = month ?? data?.today.slice(0, 7) ?? null;
  useEffect(() => { if (!month && data) setMonth(data.today.slice(0, 7)); }, [month, data]);
  const [selected, setSelected] = useState<string | null>(null);
  const byDate = useMemo(() => {
    const map = new Map<string, { name: string; status: 'approved' | 'pending'; session: string }[]>();
    if (!data || !month) return map;
    for (const p of data.items) for (const d of p.dates) {
      const list = map.get(d.date) ?? []; list.push({ name: p.name, status: d.status, session: d.session }); map.set(d.date, list);
    }
    return map;
  }, [data, month]);
  const sessions: Record<string, string> = { full_day: t('fullDay'), AM: t('halfAM'), PM: t('halfPM'), hourly: t('hourly') };
  const today = data?.today ?? null;
  const day = selected ?? (shown && today?.startsWith(shown) ? today : null);
  const away = day ? byDate.get(day) ?? [] : [];
  const weekdays = useMemo(() => Array.from({ length: 7 }, (_, i) => fmtCalendarDate(`2024-01-${pad(i + 1)}`, false).split(/[\s,]+/)[0]!), []);

  if (data && !data.enabled) return <Screen back><Title>{t('qaTeamCalendar')}</Title><Muted>{t('teamCalendarOff')}</Muted></Screen>;
  const g = shown ? monthGrid(shown) : null;
  return <Screen back onRefresh={team.reload}>
    <Title>{t('qaTeamCalendar')}</Title>
    {shown && <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
      <Pressable accessibilityRole="button" accessibilityLabel={t('calPrevMonth')} hitSlop={8} onPress={() => { setSelected(null); setMonth(shiftMonth(shown, -1)); }} style={{ minWidth: 44, minHeight: 44, justifyContent: 'center' }}>
        <Text style={{ color: palette.accent, fontSize: 28 }}>‹</Text>
      </Pressable>
      <Text accessibilityRole="header" style={{ color: palette.text, fontSize: 18, fontWeight: '700' }}>{fmtMonth(shown)}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={t('calNextMonth')} hitSlop={8} onPress={() => { setSelected(null); setMonth(shiftMonth(shown, 1)); }} style={{ minWidth: 44, minHeight: 44, justifyContent: 'center', alignItems: 'flex-end' }}>
        <Text style={{ color: palette.accent, fontSize: 28 }}>›</Text>
      </Pressable>
    </View>}
    <LoadState loading={team.loading} hasData={data != null} error={team.error} onRetry={team.reload} />
    {g && <Card>
      <View style={{ flexDirection: 'row' }}>{weekdays.map((w, i) => <Text key={i} style={{ width: `${100 / 7}%`, textAlign: 'center', color: palette.muted, fontSize: 12, fontWeight: '600' }}>{w}</Text>)}</View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        {Array.from({ length: g.lead }, (_, i) => <View key={`lead-${i}`} style={{ width: `${100 / 7}%`, height: 52 }} />)}
        {g.dates.map((date) => {
          const list = month === shown ? byDate.get(date) ?? [] : [];
          const approved = list.filter((x) => x.status === 'approved').length, pending = list.length - approved;
          const isToday = date === today, isSel = date === day;
          return <Pressable key={date} accessibilityRole="button" accessibilityState={{ selected: isSel }}
            accessibilityLabel={`${fmtCalendarDate(date)}. ${t('calAwayCount', { n: approved })}${pending ? `, ${t('calPendingCount', { n: pending })}` : ''}`}
            onPress={() => setSelected(date)} style={{ width: `${100 / 7}%`, height: 52, alignItems: 'center', justifyContent: 'center', gap: 3 }}>
            <View style={{ width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: isSel ? palette.accent : isToday ? tint(palette.accent, 0.14, palette.card) : 'transparent' }}>
              <Text style={{ color: isSel ? palette.bg : palette.text, fontWeight: isToday || isSel ? '800' : '500', fontSize: 15 }}>{Number(date.slice(8))}</Text>
            </View>
            <View style={{ flexDirection: 'row', gap: 2, height: 6 }}>
              {Array.from({ length: Math.min(approved, 3) }, (_, i) => <View key={`a${i}`} style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: palette.accent }} />)}
              {Array.from({ length: Math.min(pending, 3 - Math.min(approved, 3)) }, (_, i) => <View key={`p${i}`} style={{ width: 5, height: 5, borderRadius: 3, borderWidth: 1, borderColor: palette.accent }} />)}
            </View>
          </Pressable>;
        })}
      </View>
      <View style={{ flexDirection: 'row', gap: 16, marginTop: 4 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: palette.accent }} /><Muted>{t('approved')}</Muted></View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><View style={{ width: 8, height: 8, borderRadius: 4, borderWidth: 1, borderColor: palette.accent }} /><Muted>{t('pending')}</Muted></View>
      </View>
    </Card>}
    {day && month === shown && <View style={{ gap: 10 }}>
      <Text accessibilityRole="header" style={{ color: palette.text, fontSize: 17, fontWeight: '700' }}>{fmtCalendarDate(day)}</Text>
      {away.length === 0 ? <Muted>{t('calNobodyAway')}</Muted> : away.map((p, i) => <View key={`${p.name}-${i}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 6 }}>
        <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: tint(palette.accent, 0.14, palette.card), alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: palette.accent, fontWeight: '700' }}>{initials(p.name)}</Text></View>
        <View style={{ flex: 1 }}>
          <Text style={{ color: palette.text, fontSize: 16, fontWeight: '600' }}>{p.name}</Text>
          <Muted>{[p.status === 'approved' ? t('approved') : t('pending'), sessions[p.session]].filter(Boolean).join(' · ')}</Muted>
        </View>
      </View>)}
    </View>}
    {data?.truncated && <Muted>{t('teamTruncated', { shown: data.items.length, total: data.memberCount })}</Muted>}
    {data && <Muted>{t('teamAccessNotice')}</Muted>}
  </Screen>;
}
