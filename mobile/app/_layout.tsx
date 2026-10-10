import { JourneyDraftProvider } from '../lib/journey-drafts';
import { TenantDesignProvider, useTenantDesign } from '../lib/design';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { t } from '../lib/i18n';
import { SessionProvider, useSession } from '../lib/session';
import { Button, colors } from '../lib/ui';

function ThemedStack() {
  const { palette } = useTenantDesign();
  return <><StatusBar style={palette.text === '#111111' ? 'dark' : 'light'} /><Stack screenOptions={{ headerShown: false }} /></>;
}

function Gate() {
  const { status, visible, error, unlocking, unlock, signOut } = useSession();
  if (status === 'loading' || !visible) {
    return (
      <View style={styles.center}>
        <ActivityIndicator accessibilityLabel={t('loading')} />
      </View>
    );
  }
  if (status === 'locked') {
    return (
      <View style={styles.center}>
        <Text style={styles.lockTitle}>{t('unlockTitle')}</Text>
        {error && <Text style={styles.problem}>{t('genericError')}</Text>}
        <View style={styles.actions}>
          <Button title={t('unlockButton')} disabled={unlocking} onPress={() => void unlock()} />
          <Button title={t('signOut')} onPress={() => void signOut()} kind="quiet" />
        </View>
      </View>
    );
  }
  return status === 'signedIn' ? <TenantDesignProvider><ThemedStack /></TenantDesignProvider> : <Stack screenOptions={{ headerShown: false }} />;
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <SessionProvider>
        <StatusBar style="dark" />
        <JourneyDraftProvider><Gate /></JourneyDraftProvider>
      </SessionProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg, padding: 24 },
  lockTitle: { fontSize: 20, fontWeight: '600', color: colors.text, marginBottom: 16 },
  actions: { alignSelf: 'stretch', gap: 8 },
  problem: { color: colors.danger, marginBottom: 12 },
});
