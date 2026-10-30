/**
 * Staff directory — the web's everyday People directory (/personnel) on the phone, read through
 * GET /api/mobile/v2/directory. Who appears, and which contact fields, is the server's: the same role screen access,
 * company scope and row-level security as the web list. `enabled: false` means this role has no directory. Search
 * and paging are the only choices the app makes; nothing is cached beyond the screen.
 */
import { useEffect, useState } from 'react';
import { Linking, Pressable, TextInput, View } from 'react-native';
import { DesignText as Text, useTenantDesign } from '../lib/design';
import { useApiV2 } from '../lib/api';
import { Icon } from '../lib/icon';
import { initials, tint } from '../lib/home-hero';
import { t } from '../lib/i18n';
import { useSession } from '../lib/session';
import { Button, LoadState, Muted, Screen, Title } from '../lib/ui';
import { DirectoryPageV2 } from '../../lib/mobile-api/v2/directory';

type Person = DirectoryPageV2['items'][number];
const PAGE = 25, MAX = 50;

export default function Directory() {
  const { palette, design } = useTenantDesign();
  const { signOut } = useSession();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { const id = setTimeout(() => { setQ(text.trim().slice(0, 100)); setLimit(PAGE); }, 300); return () => clearTimeout(id); }, [text]);
  // One read of the first `limit` people; "Show more" widens it up to the server's 50 per read, then asks to refine.
  const first = useApiV2('v2/directory', DirectoryPageV2, { q: q || undefined, offset: '0', limit: String(limit) }, signOut);
  const data = first.data;
  const items: Person[] = data?.items ?? [];
  const radius = design.schemaVersion === 2 ? design.composition.layout.radius : design.corners === 'soft' ? 14 : 4;

  if (data && !data.enabled) return <Screen back><Title>{t('qaDirectory')}</Title><Muted>{t('directoryOff')}</Muted></Screen>;
  return <Screen back onRefresh={first.reload}>
    <Title>{t('qaDirectory')}</Title>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, minHeight: 48, borderRadius: radius, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.card }}>
      <Icon name="search" color={palette.muted} size={18} />
      <TextInput accessibilityLabel={t('directorySearch')} placeholder={t('directorySearch')} placeholderTextColor={palette.muted} value={text} onChangeText={setText}
        autoCorrect={false} autoCapitalize="none" returnKeyType="search" maxLength={100} style={{ flex: 1, color: palette.text, fontSize: 16, minHeight: 46 }} />
    </View>
    <LoadState loading={first.loading} hasData={data != null} error={first.error} onRetry={first.reload} />
    {data && <Muted>{t('directoryCount', { n: data.total })}</Muted>}
    {data && items.length === 0 && <Muted>{q ? t('directoryNoMatch') : t('directoryEmpty')}</Muted>}
    <View>
      {items.map((p) => {
        const expanded = open === p.employmentId, role = [p.position, p.department].filter(Boolean).join(' · ');
        return <View key={p.employmentId} style={{ borderBottomWidth: 1, borderColor: palette.border }}>
          <Pressable accessibilityRole="button" accessibilityState={{ expanded }} accessibilityLabel={[p.name, role, p.company].filter(Boolean).join('. ')}
            onPress={() => setOpen(expanded ? null : p.employmentId)} style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 64, paddingVertical: 10 }, pressed && { opacity: 0.7 }]}>
            <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: tint(palette.accent, 0.14, palette.card), alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ color: palette.accent, fontWeight: '800' }}>{initials(p.name)}</Text>
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ color: palette.text, fontSize: 16, fontWeight: '600' }}>{p.name}</Text>
              {role ? <Text numberOfLines={1} style={{ color: palette.muted, fontSize: 14 }}>{role}</Text> : null}
            </View>
            <Text style={{ color: palette.muted, fontSize: 20 }}>{expanded ? '⌃' : '›'}</Text>
          </Pressable>
          {expanded && <View style={{ paddingLeft: 56, paddingBottom: 12, gap: 8 }}>
            <Muted>{p.company}</Muted>
            {p.email && <ContactButton icon="mail" label={p.email} onPress={() => void Linking.openURL(`mailto:${p.email}`)} />}
            {p.phone && <ContactButton icon="phone" label={p.phone} onPress={() => void Linking.openURL(`tel:${p.phone!.replace(/[^\d+]/g, '')}`)} />}
            {!p.email && !p.phone && <Muted>{t('directoryNoContact')}</Muted>}
          </View>}
        </View>;
      })}
    </View>
    {data && items.length < data.total && limit < MAX && <Button title={t('showMore')} kind="quiet" onPress={() => setLimit((n) => Math.min(MAX, n + PAGE))} />}
    {data && items.length < data.total && limit >= MAX && <Muted>{t('directoryRefine')}</Muted>}
  </Screen>;
}

function ContactButton({ icon, label, onPress }: { icon: 'mail' | 'phone'; label: string; onPress: () => void }) {
  const { palette } = useTenantDesign();
  return <Pressable accessibilityRole="link" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 }, pressed && { opacity: 0.6 }]}>
    <Icon name={icon} color={palette.accent} size={18} /><Text style={{ color: palette.accent, fontSize: 15 }}>{label}</Text>
  </Pressable>;
}
