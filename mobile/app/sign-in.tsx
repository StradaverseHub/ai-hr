/**
 * Sign-in (ADR-0088 §1): WorkOS hosted AuthKit in the system browser, authorization code + PKCE.
 * expo-auth-session generates the verifier and challenge and checks `state` on return.
 */
import * as AuthSession from 'expo-auth-session';
import { Redirect, router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { beginSignIn, completeSignIn, discovery, redirectUri } from '../lib/auth';
import { config, configProblem } from '../lib/config';
import { t } from '../lib/i18n';
import { useSession } from '../lib/session';
import { Button, colors } from '../lib/ui';

WebBrowser.maybeCompleteAuthSession();

export default function SignIn() {
  const session = useSession();
  const problem = configProblem();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [failed, setFailed] = useState(false);
  const [request, , promptAsync] = AuthSession.useAuthRequest(
    {
      clientId: config.workosClientId,
      redirectUri: redirectUri(),
      responseType: AuthSession.ResponseType.Code,
      usePKCE: true,
      scopes: [],
      extraParams: { provider: 'authkit' },
    },
    discovery,
  );

  if (session.status === 'signedIn') return <Redirect href="/" />;

  const onSignIn = async () => {
    if (pending.current || !request || problem) return;
    pending.current = true;
    const owner = beginSignIn();
    setFailed(false);
    setBusy(true);
    try {
      const r = await promptAsync();
      if (r.type === 'success' && typeof r.params.code === 'string' && request?.codeVerifier) {
        await completeSignIn(r.params.code, request.codeVerifier, owner);
        await session.markSignedIn(owner);
        router.replace('/');
      } else if (r.type !== 'cancel' && r.type !== 'dismiss') {
        setFailed(true);
      }
    } catch {
      setFailed(true);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  return (
    <View style={styles.wrap}>
      <Text style={styles.brand}>{t('appName')}</Text>
      <Text style={styles.title}>{t('signInTitle')}</Text>
      <Text style={styles.body}>{t('signInBody')}</Text>
      {problem ? (
        <Text style={styles.problem}>
          {t('notConfigured')} {problem}
        </Text>
      ) : (
        <Button title={busy ? t('signingIn') : t('signInButton')} disabled={busy || !request} onPress={() => void onSignIn()} />
      )}
      {failed && <Text style={styles.problem}>{t('signInFailed')}</Text>}
      {session.error && <Text style={styles.problem}>{t('genericError')}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, justifyContent: 'center', padding: 24, gap: 12, backgroundColor: colors.bg },
  brand: { fontSize: 15, fontWeight: '700', color: colors.accent, letterSpacing: 1 },
  title: { fontSize: 28, fontWeight: '700', color: colors.text },
  body: { fontSize: 16, color: colors.muted, marginBottom: 12 },
  problem: { fontSize: 14, color: colors.danger },
});
