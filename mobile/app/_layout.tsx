import { JourneyDraftProvider } from '../lib/journey-drafts';
import { CompanyConnectionProvider, WorkplaceReviewBoundary, useCompanyConnection } from '../lib/company-connection';
import { TenantDesignProvider, useTenantDesign } from '../lib/design';
import { Stack, router } from 'expo-router';
import { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, Alert, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { t, type MessageKey } from '../lib/i18n';
import { Icon } from '../lib/icon';
import { biometricName, useLockCapability } from '../lib/app-lock';
import { takeReopenAfterLanguage, useDisplayPrefs } from '../lib/preferences';
import { SessionProvider, useSession } from '../lib/session';
import { PushLifecycle, PushSessionWatcher } from '../lib/push';
import {authGeneration} from '../lib/auth';
import { Button, colors } from '../lib/ui';

function ThemedStack() {
  const { palette } = useTenantDesign();
  useEffect(() => { const path = takeReopenAfterLanguage(); if (path) setTimeout(() => router.push(path), 0); }, []);
  return <><StatusBar style={palette.text === '#111111' ? 'dark' : 'light'} /><PushLifecycle /><Stack screenOptions={{ headerShown: false }} /></>;
}

function Gate() {
  const { status, visible, error, unlocking, unlock, signOut } = useSession();
  const company=useCompanyConnection();
  // Navigate only AFTER the signed-out Stack commits, including the first connection setup.
  useEffect(()=>{if(company&&status==='signedOut'&&visible)router.replace('/sign-in');},[company,status,visible]);
  if (status === 'loading' || !visible) {
    return (
      <View style={styles.center}>
        <ActivityIndicator accessibilityLabel={t('loading')} />
      </View>
    );
  }
  if (status === 'locked') {
    return <LockScreen error={error} unlocking={unlocking} unlock={unlock} signOut={signOut} />;
  }
  return status === 'signedIn' ? <TenantDesignProvider><ThemedStack /></TenantDesignProvider> : <Stack screenOptions={{ headerShown: false }} />;
}

/** The app lock: the phone's own biometric named and pictured, one unlock button, and sign out as the way past it. */
function LockScreen({ error, unlocking, unlock, signOut }: { error: boolean; unlocking: boolean; unlock: () => Promise<void>; signOut: () => Promise<void> }) {
  const cap = useLockCapability();
  const name = cap ? biometricName(cap.method) : 'passcode';
  const icon = name === 'faceId' || name === 'faceUnlock' ? 'faceId' : name === 'touchId' || name === 'fingerprint' ? 'touchId' : 'lock';
  const label: MessageKey = ({ faceId: 'unlockWithFaceId', faceUnlock: 'unlockWithFace', touchId: 'unlockWithTouchId', fingerprint: 'unlockWithFingerprint', iris: 'unlockWithIris' } as Record<string, MessageKey>)[name] ?? 'unlockButton';
  return (
      <View style={styles.center}>
        <View style={styles.lockBadge}><Icon name={icon} color={colors.accent} size={44} /></View>
        <Text style={styles.lockTitle}>{t('unlockTitle')}</Text>
        <Text style={styles.lockBody}>{t('unlockBody')}</Text>
        {error && <Text style={styles.problem}>{t('genericError')}</Text>}
        <View style={styles.actions}>
          <Button title={t(label)} disabled={unlocking} onPress={() => void unlock()} />
          <Button title={t('signOut')} onPress={() => {const owner=authGeneration();Alert.alert(t('signOut'),t('pendingLockedLogout'),[{text:t('cancel'),style:'cancel'},{text:t('signOut'),onPress:()=>{if(authGeneration()===owner)void signOut();}}]);}} kind="quiet" />
        </View>
      </View>
    );
}

export default function RootLayout() {
  const { language } = useDisplayPrefs();
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <CompanyConnectionProvider><SessionProvider>
        <PushSessionWatcher />
        {/* A language change re-renders every screen in the new language: the screens below the session remount (the
            session, its lock and any draft above them are kept), and Settings reopens itself. */}
        <JourneyDraftProvider><WorkplaceReviewBoundary><Gate key={language} /></WorkplaceReviewBoundary></JourneyDraftProvider>
      </SessionProvider></CompanyConnectionProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg, padding: 24 },
  lockTitle: { fontSize: 24, fontWeight: '800', color: colors.text, marginBottom: 8, textAlign: 'center' },
  lockBody: { fontSize: 15, color: colors.muted, marginBottom: 28, textAlign: 'center', lineHeight: 21 },
  lockBadge: { width: 96, height: 96, borderRadius: 48, backgroundColor: '#1F5EFF1A', alignItems: 'center', justifyContent: 'center', marginBottom: 20 },
  actions: { alignSelf: 'stretch', gap: 8 },
  problem: { color: colors.danger, marginBottom: 12 },
});
