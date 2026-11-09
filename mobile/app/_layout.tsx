import { PublicHeader } from '../lib/public-header';
import { ReadSnapshotBoundary } from '../lib/api';
import { DesignText as Text } from '../lib/design';
import { SignedInShell } from '../lib/app-shell';
import {WidgetLaunchObserver} from '../lib/widget-launch';
import { JourneyDraftProvider, useJourneyDrafts } from '../lib/journey-drafts';
import { CompanyConnectionProvider, WorkplaceReviewBoundary, useCompanyConnection } from '../lib/company-connection';
import { Atmosphere, PublicDesignProvider, TenantDesignProvider, useTenantDesign } from '../lib/design';
import { colorContrast } from '../../lib/mobile-composition';
import { Stack, useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { MfaResumeContext } from '../lib/mfa-resume';
import { useFonts } from 'expo-font';
import { FIELD_NOTES_FONTS } from '../lib/field-typography';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { t, type MessageKey } from '../lib/i18n';
import { Icon } from '../lib/icon';
import { biometricName, useLockCapability } from '../lib/app-lock';
import { takeReopenAfterLanguage, useDisplayPrefs } from '../lib/preferences';
import { SessionProvider, useSession } from '../lib/session';
import { PushLifecycle, PushSessionWatcher } from '../lib/push';
import {authGeneration} from '../lib/auth';
import { Button, colors } from '../lib/ui';

function ThemedStatusBar() {
  const { palette } = useTenantDesign();
  return <StatusBar style={colorContrast(palette.bg, '#000000') > colorContrast(palette.bg, '#ffffff') ? 'dark' : 'light'} />;
}

function ThemedStack() {
  const router = useRouter();
  const { palette, reduceMotion } = useTenantDesign();
  const { leave, putLeave } = useJourneyDrafts();
  useEffect(() => {
    if (!leave?.reopenAfterAttachment) return;
    // This stack only mounts after authentication. Consume the navigation
    // request through the draft owner before opening its screen.
    const timer = setTimeout(() => {
      if (putLeave({ ...leave, reopenAfterAttachment: false }, leave.command.requestId)) {
        router.navigate('/leave');
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [leave, putLeave, router]);
  useEffect(() => { const path = takeReopenAfterLanguage(); if (path) setTimeout(() => router.push(path), 0); }, [router]);
  return <><StatusBar style={colorContrast(palette.bg, '#000000') > colorContrast(palette.bg, '#ffffff') ? 'dark' : 'light'} /><PushLifecycle /><SignedInShell><Stack screenOptions={{ headerShown: false, animation: reduceMotion ? 'fade' : 'default' }} /></SignedInShell></>;
}

function Gate() {
  const router = useRouter();
  const { status, visible, error, unlocking, unlock, signOut } = useSession();
  const company=useCompanyConnection();
  const mfaResume = useRef<{ owner: number; challenge: string } | null>(null);
  useEffect(() => { if (status !== 'signedOut') mfaResume.current = null; }, [status]);
  const { palette } = useTenantDesign();
  // Navigate only AFTER the signed-out Stack commits, including the first connection setup.
  useEffect(()=>{if(company&&status==='signedOut'&&visible)router.replace('/sign-in');},[company,status,visible,router]);
  if (status === 'loading' || !visible) {
    return (
      <View style={[styles.center, { backgroundColor: palette.bg }]}>
        <ActivityIndicator accessibilityLabel={t('loading')} />
      </View>
    );
  }
  if (status === 'locked') {
    return <LockScreen error={error} unlocking={unlocking} unlock={unlock} signOut={signOut} />;
  }
  return status === 'signedIn' ? <ReadSnapshotBoundary><TenantDesignProvider><ThemedStack /></TenantDesignProvider></ReadSnapshotBoundary> : <MfaResumeContext.Provider value={mfaResume}><Stack screenOptions={{ headerShown: false }} /></MfaResumeContext.Provider>;
}

/** The app lock: the phone's own biometric named and pictured, one unlock button, and sign out as the way past it. */
function LockScreen({ error, unlocking, unlock, signOut }: { error: boolean; unlocking: boolean; unlock: () => Promise<void>; signOut: () => Promise<void> }) {
  const { palette } = useTenantDesign();
  const cap = useLockCapability();
  const name = cap ? biometricName(cap.method) : 'passcode';
  const icon = name === 'faceId' || name === 'faceUnlock' ? 'faceId' : name === 'touchId' || name === 'fingerprint' ? 'touchId' : 'lock';
  const label: MessageKey = ({ faceId: 'unlockWithFaceId', faceUnlock: 'unlockWithFace', touchId: 'unlockWithTouchId', fingerprint: 'unlockWithFingerprint', iris: 'unlockWithIris' } as Record<string, MessageKey>)[name] ?? 'unlockButton';
  return (
      <SafeAreaView style={{ flex: 1, backgroundColor: palette.bg }}>
      <ScrollView contentContainerStyle={{ flexGrow: 1, padding: 24, gap: 20 }}>
        <PublicHeader />
        <Atmosphere strong />
        <View style={[styles.lockBadge, { backgroundColor: palette.card }]}><Icon name={icon} color={palette.accent} size={44} /></View>
        <Text style={[styles.lockTitle, { color: palette.text }]}>{t('unlockTitle')}</Text>
        <Text style={[styles.lockBody, { color: palette.muted }]}>{t('unlockBody')}</Text>
        {error && <Text accessibilityRole="alert" style={[styles.problem, { color: palette.text }]}>{t('genericError')}</Text>}
        <View style={styles.actions}>
          <Button title={t(label)} disabled={unlocking} onPress={() => void unlock()} />
          <Button title={t('signOut')} onPress={() => {const owner=authGeneration();Alert.alert(t('signOut'),t('pendingLockedLogout'),[{text:t('cancel'),style:'cancel'},{text:t('signOut'),onPress:()=>{if(authGeneration()===owner)void signOut();}}]);}} kind="quiet" />
        </View>
      </ScrollView></SafeAreaView>
    );
}

export default function RootLayout() {
  const { language } = useDisplayPrefs();
  const [fontsReady, fontError] = useFonts(FIELD_NOTES_FONTS);
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <PublicDesignProvider><ThemedStatusBar /><CompanyConnectionProvider><SessionProvider>
        <PushSessionWatcher /><WidgetLaunchObserver />
        {/* A language change re-renders every screen in the new language: the screens below the session remount (the
            session, its lock and any draft above them are kept), and Settings reopens itself. */}
        <JourneyDraftProvider><WorkplaceReviewBoundary>{fontsReady || fontError ? <Gate key={language} /> :
          <View style={{ flex: 1, backgroundColor: colors.bg, justifyContent: 'center' }}><ActivityIndicator accessibilityLabel={t('loading')} /></View>
        }</WorkplaceReviewBoundary></JourneyDraftProvider>
      </SessionProvider></CompanyConnectionProvider></PublicDesignProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg, padding: 24 },
  lockTitle: { fontSize: 44, fontWeight: '800', letterSpacing: -1.1, color: colors.text, marginBottom: 8 },
  lockBody: { fontSize: 15, color: colors.muted, marginBottom: 20, lineHeight: 22 },
  lockBadge: { width: 64, height: 64, borderRadius: 0, alignItems: 'center', justifyContent: 'center', marginBottom: 20 },
  actions: { alignSelf: 'stretch', gap: 8 },
  problem: { color: colors.danger, marginBottom: 12 },
});
