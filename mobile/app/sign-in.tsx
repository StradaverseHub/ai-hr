import { InternalSignIn } from '../lib/internal-sign-in';
import { fetch as nativeFetch } from 'expo/fetch';
/**
 * Sign-in (ADR-0088 §1): WorkOS hosted AuthKit in the system browser, authorization code + PKCE.
 * expo-auth-session generates the verifier and challenge and checks `state` on return.
 */
import * as AuthSession from 'expo-auth-session';
import * as Crypto from 'expo-crypto';
import { Redirect, router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { assertAuthGeneration, beginSignIn, completeSignIn, discovery, redirectUri } from '../lib/auth';
import { companyCopy, useCompanyConnection } from '../lib/company-connection';
import { verifyCompanyServer } from '../lib/connection-probe';
import { config, configProblem, identityClientId } from '../lib/config';
import { t } from '../lib/i18n';
import { useSession } from '../lib/session';
import { Atmosphere, useTenantDesign } from '../lib/design';
import { Button, colors } from '../lib/ui';

WebBrowser.maybeCompleteAuthSession();

export default function SignIn() { return config.authProvider === 'internal' ? <InternalSignIn/> : <ProviderSignIn/>; }
function ProviderSignIn() {
  const session = useSession();
  const { palette } = useTenantDesign();
  const styles = providerStyles(palette);
  const company = useCompanyConnection();
  const problem = configProblem();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [failed, setFailed] = useState(false);
  const [connectionError,setConnectionError] = useState('');
  if (session.status === 'signedIn') return <Redirect href="/" />;

  const onSignIn = async () => {
    if (pending.current || problem) return;
    pending.current = true;
    const owner = beginSignIn();
    setFailed(false);
    setConnectionError('');
    setBusy(true);
    try {
      if(company) { try{await verifyCompanyServer(company,nativeFetch);}catch{setConnectionError(companyCopy().signInUnavailable);return;} }
      assertAuthGeneration(owner);
      if(configProblem())throw new Error('Company setup is no longer valid.');
      const pinnedDiscovery={authorizationEndpoint:discovery.authorizationEndpoint,tokenEndpoint:discovery.tokenEndpoint};
      // A hook-held request reuses its state/verifier after cancellation. Each browser attempt
      // must own fresh values so a delayed callback cannot complete a subsequent attempt.
      const request = new AuthSession.AuthRequest({
        clientId: identityClientId(),
        redirectUri: redirectUri(),
        responseType: AuthSession.ResponseType.Code,
        state: Crypto.randomUUID(),
        usePKCE: true,
        scopes: config.authProvider === 'keycloak' ? ['openid', 'profile', 'email'] : [],
        extraParams: config.authProvider === 'keycloak' ? { nonce: Crypto.randomUUID() } : { provider: 'authkit' },
      });
      await request.makeAuthUrlAsync(pinnedDiscovery);
      assertAuthGeneration(owner);
      const r = await request.promptAsync(pinnedDiscovery);
      if (r.type === 'success' && typeof r.params.code === 'string' && request.codeVerifier) {
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
    <View style={{ flex: 1, backgroundColor: palette.bg }}><Atmosphere strong /><ScrollView contentContainerStyle={styles.wrap}>
      <Text style={styles.brand}>{t('appName')}</Text>
      <Text style={styles.title}>{t('signInTitle')}</Text>
      <Text style={styles.body}>{t('signInBody')}</Text>
      {company&&<><Text style={styles.body}>{company.name} · {new URL(company.apiOrigin).hostname}</Text><Button title={companyCopy().change} kind="quiet" disabled={busy} onPress={()=>router.push('/company')}/></>}
      {problem ? (
        <Text style={styles.problem}>
          {t('notConfigured')} {problem}
        </Text>
      ) : (
        <Button title={busy ? t('signingIn') : t('signInButton')} disabled={busy} onPress={() => void onSignIn()} />
      )}
      {failed && <Text style={styles.problem}>{t('signInFailed')}</Text>}
      {connectionError&&<Text accessibilityRole="alert" style={styles.problem}>{connectionError}</Text>}
      {session.error && <Text style={styles.problem}>{t('genericError')}</Text>}
    </ScrollView></View>
  );
}

const providerStyles = (palette: {bg:string;text:string;muted:string;accent:string}) => StyleSheet.create({
  wrap: { flexGrow: 1, justifyContent: 'center', padding: 24, gap: 24 },
  brand: { fontSize: 15, fontWeight: '700', color: palette.accent, textAlign: 'center' },
  title: { fontSize: 34, fontWeight: '700', color: palette.text },
  body: { fontSize: 16, color: palette.muted, marginBottom: 12 },
  problem: { fontSize: 14, color: palette.text },
});
