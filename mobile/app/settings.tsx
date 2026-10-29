/**
 * Settings (Mobile WOW round) — what belongs to this phone, moved off Me: Security (the app lock and its biometric,
 * screenshot protection), notifications and shift reminders, device registration, saved submissions, changing
 * company and signing out. The app lock is always on: there is no switch to turn it off (lib/app-lock.ts).
 */
import { useEffect, useRef } from 'react';
import { Linking, Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { companyCopy, useCompanyConnection } from '../lib/company-connection';
import { DesignText as Text, useTenantDesign } from '../lib/design';
import { biometricName, useLockCapability } from '../lib/app-lock';
import { Icon, type IconName } from '../lib/icon';
import { tint } from '../lib/home-hero';
import { LANGUAGE_NAMES, deviceLocale, t, type MessageKey } from '../lib/i18n';
import { APP_LOCALES, reopenAfterLanguageChange, setDisplayPref, useDisplayPrefs, type AppearancePref, type LanguagePref } from '../lib/preferences';
import { useSession } from '../lib/session';
import { useQueuedOfflinePunches } from '../lib/offline-clock';
import { NotificationsRow, ShiftReminderSetting } from '../lib/push';
import { Card, Chip, ListRow, Muted, Screen, SectionLabel, Title } from '../lib/ui';

const METHOD_LABEL: Record<string, MessageKey> = {
  faceId: 'lockFaceId', faceUnlock: 'lockFaceUnlock', touchId: 'lockTouchId', fingerprint: 'lockFingerprint', iris: 'lockIris', passcode: 'lockPasscode', none: 'lockNone',
};

export default function Settings() {
  const company = useCompanyConnection();
  const { status } = useSession();
  const cap = useLockCapability();
  const signedIn = useRef(status === 'signedIn'); signedIn.current = status === 'signedIn';
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // Offline punches stay on this phone across sign-out; shown as information beside Sign out, never as a blocker.
  const queued = useQueuedOfflinePunches(() => mounted.current && signedIn.current);
  const name = cap ? biometricName(cap.method) : null;
  const lockIcon: IconName = name === 'faceId' || name === 'faceUnlock' ? 'faceId' : name === 'touchId' || name === 'fingerprint' ? 'touchId' : 'lock';

  return <Screen back>
    <Title>{t('qaSettings')}</Title>
    <SectionLabel>{t('settingsDisplay')}</SectionLabel>
    <DisplaySettings />
    <SectionLabel>{t('settingsSecurity')}</SectionLabel>
    <Card>
      <StatusRow icon={lockIcon} title={t('settingsAppLock')} value={name ? t(METHOD_LABEL[name]!) : '…'} body={t(cap?.method === 'passcode' ? 'settingsAppLockPasscode' : 'settingsAppLockBody')} />
      {cap && cap.biometricHardware && !cap.biometricEnrolled && <ListRow label={t('settingsSetUpBiometrics')} onPress={() => void Linking.openSettings()} />}
      <StatusRow icon="eyeOff" title={t('settingsScreenshots')} value={t('settingsBlocked')} body={t('settingsScreenshotsBody')} />
    </Card>
    <SectionLabel>{t('settingsNotifications')}</SectionLabel>
    <View>
      <ShiftReminderSetting />
      <NotificationsRow />
    </View>
    <SectionLabel>{t('meSectionDevice')}</SectionLabel>
    <View>
      <ListRow label={t('integrityKeysTitle')} onPress={() => router.push('/integrity-keys')} />
      <ListRow label={t('pendingTitle')} onPress={() => router.push('/pending-submissions')} />
      {company && <ListRow label={companyCopy().change} onPress={() => router.push({ pathname: '/pending-submissions', params: { intent: 'company' } })} />}
      <ListRow label={t('signOut')} onPress={() => router.push({ pathname: '/pending-submissions', params: { intent: 'logout' } })} />
    </View>
    {queued > 0 && <Muted>{t(queued === 1 ? 'offlineSignOutNoteOne' : 'offlineSignOutNote', { n: queued })}</Muted>}
  </Screen>;
}

function StatusRow({ icon, title, value, body }: { icon: IconName; title: string; value: string; body: string }) {
  const { palette } = useTenantDesign();
  return <View accessible accessibilityLabel={`${title}: ${value}. ${body}`} style={{ flexDirection: 'row', gap: 14, paddingVertical: 6 }}>
    <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: tint(palette.accent, 0.12, palette.bg), alignItems: 'center', justifyContent: 'center' }}><Icon name={icon} color={palette.accent} size={20} /></View>
    <View style={{ flex: 1, gap: 3 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
        <Text style={{ color: palette.text, fontSize: 16, fontWeight: '600', flexShrink: 1 }}>{title}</Text>
        <Text style={{ color: palette.accent, fontSize: 15, fontWeight: '600' }}>{value}</Text>
      </View>
      <Text style={{ color: palette.muted, fontSize: 13, lineHeight: 18 }}>{body}</Text>
    </View>
  </View>;
}

const APPEARANCE: { value: AppearancePref; label: MessageKey }[] = [
  { value: 'auto', label: 'appearanceAuto' }, { value: 'light', label: 'appearanceLight' }, { value: 'dark', label: 'appearanceDark' },
];

/** Appearance and language: this phone's own choices (lib/preferences.ts), applied at once. */
function DisplaySettings() {
  const { palette } = useTenantDesign();
  const prefs = useDisplayPrefs();
  const chooseLanguage = (value: LanguagePref) => {
    if (value === prefs.language) return;
    reopenAfterLanguageChange('/settings');
    setDisplayPref('language', value);
  };
  const options: { value: LanguagePref; title: string; hint?: string }[] = [
    { value: 'auto', title: t('languageAuto'), hint: LANGUAGE_NAMES[deviceLocale()] },
    ...APP_LOCALES.map((code) => ({ value: code as LanguagePref, title: LANGUAGE_NAMES[code] })),
  ];
  return <Card>
    <Text style={{ color: palette.text, fontSize: 16, fontWeight: '600' }}>{t('settingsAppearance')}</Text>
    <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {APPEARANCE.map((a) => <Chip key={a.value} title={t(a.label)} selected={prefs.appearance === a.value} onPress={() => setDisplayPref('appearance', a.value)} />)}
    </View>
    {prefs.appearance === 'auto' && <Muted>{t('appearanceAutoHint')}</Muted>}
    <Text style={{ color: palette.text, fontSize: 16, fontWeight: '600', marginTop: 10 }}>{t('settingsLanguage')}</Text>
    <View accessibilityRole="radiogroup">
      {options.map((o, i) => {
        const selected = prefs.language === o.value;
        return <Pressable key={o.value} accessibilityRole="radio" accessibilityState={{ selected }} accessibilityLabel={o.hint ? `${o.title}, ${o.hint}` : o.title}
          onPress={() => chooseLanguage(o.value)}
          style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48, borderTopWidth: i ? 1 : 0, borderColor: palette.border }, pressed && { opacity: 0.6 }]}>
          <View style={{ flex: 1 }}>
            <Text style={{ color: palette.text, fontSize: 16, fontWeight: selected ? '700' : '400' }}>{o.title}</Text>
            {o.hint ? <Text style={{ color: palette.muted, fontSize: 13 }}>{o.hint}</Text> : null}
          </View>
          {selected ? <Text style={{ color: palette.accent, fontSize: 18, fontWeight: '800' }}>✓</Text> : null}
        </Pressable>;
      })}
    </View>
    {prefs.language === 'auto' && <Muted>{t('languageAutoHint')}</Muted>}
  </Card>;
}
