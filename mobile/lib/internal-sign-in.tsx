import { useRef, useState } from 'react';
import { fetch as nativeFetch } from 'expo/fetch';
import { Image, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Redirect, router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { beginSignIn, assertAuthGeneration, completeInternalSignIn } from './auth';
import { useCompanyConnection, companyCopy } from './company-connection';
import { verifyCompanyServer } from './connection-probe';
import { config, runtimeConnections } from './config';
import { internalAuthRequest, InternalSignInError, type InternalReply } from './internal-auth';
import { useSession } from './session';
import { Button, colors } from './ui';
import { Atmosphere, useTenantDesign } from './design';
import { appLocale, t } from './i18n';
import authCopy from './internal-auth-copy.json';

export function InternalSignIn() {
  const company = useCompanyConnection(), session = useSession();
  const { palette } = useTenantDesign();
  const styles = signInStyles(palette);
  const workplaceOrganization = company?.organization ?? '';
  const copy = authCopy[appLocale()];
  const [step, setStep] = useState<InternalReply | null>(null), [organization, setOrganization] = useState('');
  const [username, setUsername] = useState(''), [password, setPassword] = useState(''), [confirmation, setConfirmation] = useState(''), [code, setCode] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const pending = useRef(false), owner = useRef<number | null>(null);
  async function finish(result: InternalReply) {
    if (owner.current === null || !result.access_token || !result.refresh_token) return;
    assertAuthGeneration(owner.current);
    await completeInternalSignIn({ access_token: result.access_token, refresh_token: result.refresh_token, expires_in: result.expires_in }, owner.current);
    await session.markSignedIn(owner.current); router.replace('/');
  }
  async function submit() {
    if (pending.current) return;
    if (step?.step === 'password' && password !== confirmation) { setError('passwordMismatch'); return; }
    pending.current = true; setBusy(true); setError('');
    const body: Record<string, string> = step ? { challenge: step.challenge!, ...(step.step === 'password' ? { password } : { code }) } : { organization: workplaceOrganization || organization, username, password };
    setPassword(''); setConfirmation(''); setCode('');
    try {
      if (!step) {
        owner.current = beginSignIn();
        if (runtimeConnections && !company) throw new InternalSignInError('unavailable');
        if (company) await verifyCompanyServer(company,nativeFetch);
        assertAuthGeneration(owner.current);
      }
      const result = await internalAuthRequest(!step ? 'login' : step.step === 'password' ? 'password' : 'mfa', body, owner.current!);
      assertAuthGeneration(owner.current!); setStep(result);
      if (result.step === 'complete' && !result.recoveryCodes?.length) await finish(result);
    } catch (e) { setError(e instanceof InternalSignInError ? e.code : 'unavailable'); }
    finally { pending.current = false; setBusy(false); }
  }
  if (session.status === 'signedIn') return <Redirect href="/"/>;
  const errorText = copy.errors[error as keyof typeof copy.errors] || copy.errors.unavailable;
  const state = step?.step || 'login';
  const hasRecoveryCodes = Boolean(step?.recoveryCodes?.length);
  return <View style={{ flex: 1, backgroundColor: palette.bg }}><Atmosphere strong /><ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.wrap} keyboardDismissMode="on-drag" automaticallyAdjustKeyboardInsets>
    <Text style={styles.brand}>{t('appName')}</Text><Text accessibilityRole="header" style={styles.title}>{state === 'complete' && hasRecoveryCodes ? copy.codesTitle : state === 'password' ? copy.passwordTitle : state === 'enroll' ? copy.enrollTitle : state === 'mfa' ? copy.mfaTitle : copy.loginTitle}</Text>
    {company && <Text style={styles.body}>{company.name} · {new URL(company.apiOrigin).hostname}</Text>}
    {error && <Text accessibilityRole="alert" style={styles.error}>{errorText}</Text>}
    {state === 'complete' ? <View style={styles.fields}>
      {hasRecoveryCodes && <><Text style={styles.body}>{copy.codesHelp}</Text><Text selectable style={styles.codes}>{step?.recoveryCodes?.join('\n')}</Text></>}
      <Button title={busy ? copy.working : hasRecoveryCodes ? copy.codesSaved : copy.signIn} onPress={() => {
        if (pending.current) return;
        pending.current = true; setBusy(true); setError('');
        void finish(step!).catch(() => setError('unavailable')).finally(() => { pending.current = false; setBusy(false); });
      }} disabled={busy}/>
    </View> : <View style={styles.fields}>
      {state === 'login' && <>
        <Text style={styles.body}>{workplaceOrganization ? copy.workplaceLoginHelp : copy.loginHelp}</Text>
        {workplaceOrganization ? <Text style={styles.body}>{copy.organization}: {workplaceOrganization}</Text> :
          <><Text style={styles.label}>{copy.organization}</Text><TextInput accessibilityLabel={copy.organization} autoCapitalize="none" autoCorrect={false} maxLength={64} value={organization} onChangeText={setOrganization} style={styles.input} editable={!busy}/></>}
        <Text style={styles.label}>{copy.username}</Text><TextInput accessibilityLabel={copy.username} autoCapitalize="none" autoCorrect={false} autoComplete="username" maxLength={64} value={username} onChangeText={setUsername} style={styles.input} editable={!busy}/>
      </>}
      {(state === 'login' || state === 'password') && <>
        <Text style={styles.label}>{state === 'login' ? copy.password : copy.newPassword}</Text><TextInput accessibilityLabel={state === 'login' ? copy.password : copy.newPassword} secureTextEntry autoCapitalize="none" autoCorrect={false} maxLength={128} autoComplete={state === 'login' ? 'current-password' : 'new-password'} value={password} onChangeText={setPassword} style={styles.input} editable={!busy}/>
        {state === 'password' && <><Text style={styles.body}>{copy.passwordHelp}</Text><Text style={styles.label}>{copy.confirmation}</Text><TextInput accessibilityLabel={copy.confirmation} secureTextEntry autoCapitalize="none" autoCorrect={false} maxLength={128} value={confirmation} onChangeText={setConfirmation} style={styles.input} editable={!busy}/></>}
      </>}
      {state === 'enroll' && <>
        <Text style={styles.body}>{copy.enrollHelp}</Text>{step?.qr && <Image accessibilityLabel={copy.qrAlt} source={{ uri: step.qr }} style={styles.qr}/>}
        <Text style={styles.label}>{copy.manualKey}</Text><Text selectable style={styles.key}>{step?.secret}</Text>
      </>}
      {(state === 'enroll' || state === 'mfa') && <><Text style={styles.label}>{state === 'enroll' ? copy.code : copy.codeOrRecovery}</Text><TextInput accessibilityLabel={state === 'enroll' ? copy.code : copy.codeOrRecovery} autoCapitalize="characters" autoCorrect={false} autoComplete="one-time-code" maxLength={64} value={code} onChangeText={setCode} style={styles.input} editable={!busy}/></>}
      <Button title={busy ? copy.working : state === 'login' ? copy.signIn : copy.continue} onPress={() => void submit()} disabled={busy || (state === 'login' && (!(workplaceOrganization || organization) || !username || !password)) || (state === 'password' && (!password || !confirmation)) || ((state === 'enroll' || state === 'mfa') && !code)}/>
      {state === 'login' && <Button title={copy.forgot} kind="quiet" disabled={busy} onPress={() => void WebBrowser.openBrowserAsync(config.apiUrl + '/reset-password')}/>}
      {step && <Button title={copy.back} kind="quiet" disabled={busy} onPress={() => { beginSignIn(); owner.current = null; setStep(null); setPassword(''); setCode(''); setError(''); }}/>}
    </View>}
    <Button title={companyCopy().change} kind="quiet" disabled={busy} onPress={() => router.push('/company')}/>
  </ScrollView></View>;
}
const signInStyles = (palette: { bg: string; card: string; text: string; muted: string; border: string; accent: string }) => StyleSheet.create({ wrap: { flexGrow: 1, justifyContent: 'center', padding: 24, paddingTop: 72, paddingBottom: 40, gap: 24, width: '100%', maxWidth: 520, alignSelf: 'center' },
  brand: { color: palette.text, fontSize: 20, fontWeight: '700', textAlign: 'center', marginBottom: 16 }, title: { fontSize: 34, fontWeight: '700', letterSpacing: -0.7, color: palette.text, textAlign: 'center' },
  body: { color: palette.muted, fontSize: 15, lineHeight: 23 }, label: { color: palette.text, fontSize: 14, fontWeight: '500', marginTop: 4 }, fields: { gap: 12 }, input: { minHeight: 56, borderWidth: 1, borderColor: palette.border, borderRadius: 28, backgroundColor: palette.card, paddingVertical: 14, paddingHorizontal: 20, color: palette.text, fontSize: 16 },
  error: { color: palette.text, fontSize: 15 }, key: { color: palette.text, fontFamily: 'monospace', fontSize: 15, padding: 12, backgroundColor: palette.card }, codes: { color: palette.text, fontFamily: 'monospace', fontSize: 12, lineHeight: 28 }, qr: { width: 224, height: 224, alignSelf: 'center', backgroundColor: '#fff' } });
