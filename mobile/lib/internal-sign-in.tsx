import { useEffect, useRef, useState } from 'react';
import { runSignInClientProbe } from './signin-client-probe';
import { fetch as nativeFetch } from 'expo/fetch';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Redirect, router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { beginSignIn, assertAuthGeneration, completeInternalSignIn } from './auth';
import { useCompanyConnection, companyCopy } from './company-connection';
import { verifyCompanyServer } from './connection-probe';
import { config, runtimeConnections } from './config';
import { internalAuthRequest, InternalSignInError, type InternalReply } from './internal-auth';
import { useSession } from './session';
import { Button } from './ui';
import { useTenantDesign } from './design';
import { SignInBackground } from './sign-in-background';
import { Icon } from './icon';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { appLocale, t } from './i18n';
import authCopy from './internal-auth-copy.json';

export function InternalSignIn() {
  const company = useCompanyConnection(), session = useSession();
  const { palette } = useTenantDesign();
  const insets = useSafeAreaInsets();
  const [showPassword, setShowPassword] = useState(false);
  const styles = signInStyles(palette);
  const workplaceOrganization = company?.organization ?? '';
  const copy = authCopy[appLocale()];
  const [step, setStep] = useState<InternalReply | null>(null), [organization, setOrganization] = useState('');
  const [username, setUsername] = useState(''), [password, setPassword] = useState(''), [confirmation, setConfirmation] = useState(''), [code, setCode] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const pending = useRef(false), owner = useRef<number | null>(null);
  const probeStarted = useRef(false);
  const [probeResult, setProbeResult] = useState(process.env.EXPO_PUBLIC_SIGNIN_CLIENT_PROBE === '1' ? '{"marker":"ONEHR_CLIENT_PROBE","phase":"mounting"}' : '');
  useEffect(() => {
    if (process.env.EXPO_PUBLIC_SIGNIN_CLIENT_PROBE !== '1' || probeStarted.current) return;
    probeStarted.current = true; pending.current = true; setBusy(true);
    void runSignInClientProbe(company, setProbeResult).then(setProbeResult).finally(() => { pending.current = false; setBusy(false); });
  }, [company]);
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
  const loginDisabled = busy || !(workplaceOrganization || organization) || !username || !password;
  if (state === 'login') return <View style={{ flex: 1, backgroundColor: palette.bg }}><SignInBackground/>
    {!!probeResult && <View pointerEvents="none" style={{ position: 'absolute', top: insets.top + 4, left: 8, right: 8, zIndex: 20, padding: 10, borderRadius: 8, backgroundColor: '#fff' }}>
      <Text accessibilityLabel="Review connection diagnostic" style={{ color: '#111', fontSize: 12, lineHeight: 16 }}>{probeResult}</Text>
    </View>}
    <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" automaticallyAdjustKeyboardInsets contentContainerStyle={[styles.entry, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 24 }]}>
      <View style={styles.entryHeader}><View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}><Image accessible={false} source={require('../assets/onehr-icon.png')} style={{ width: 44, height: 44, borderRadius: 12 }}/><Text style={styles.wordmark}>{t('appName').endsWith('+') ? <>{t('appName').slice(0, -1)}<Text style={{ color: palette.accent }}>+</Text></> : t('appName')}</Text></View>
        <Pressable accessibilityRole="button" accessibilityLabel={companyCopy().change} disabled={busy} onPress={() => router.push('/company')} style={styles.workplace}>
          <Text style={styles.workplaceText}>{company?.name || companyCopy().change}</Text><Icon name="chevronDown" color={palette.text} size={14}/>
        </Pressable>
      </View>
      <View style={{ flex: 1, minHeight: 120 }}/>
      <Text accessibilityRole="header" style={styles.entryTitle}>{copy.loginTitle}</Text>
      <View style={styles.pass}>
        {workplaceOrganization ? <Text style={styles.body}>{copy.organization}: {workplaceOrganization}</Text> : <View style={styles.passField}>
          <Text style={styles.label}>{copy.organization}</Text><TextInput accessibilityLabel={copy.organization} autoCapitalize="none" autoCorrect={false} maxLength={64} value={organization} onChangeText={setOrganization} editable={!busy} style={styles.passInput}/>
        </View>}
        <View style={styles.passField}><Text style={styles.label}>{copy.username}</Text>
          <TextInput accessibilityLabel={copy.username} autoCapitalize="none" autoCorrect={false} autoComplete="username" textContentType="username" maxLength={64} value={username} onChangeText={setUsername} editable={!busy} style={styles.passInput}/>
        </View>
        <View style={styles.passField}>
          <View style={styles.fieldHeader}><Text style={styles.label}>{copy.password}</Text>
            <Pressable accessibilityRole="link" disabled={busy} onPress={() => void WebBrowser.openBrowserAsync(config.apiUrl + '/reset-password')} style={{ minHeight: 44, justifyContent: 'center' }}><Text style={styles.recovery}>{copy.forgot}</Text></Pressable>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <TextInput accessibilityLabel={copy.password} secureTextEntry={!showPassword} autoCapitalize="none" autoCorrect={false} autoComplete="current-password" textContentType="password" maxLength={128} value={password} onChangeText={setPassword} editable={!busy} style={[styles.passInput, { flex: 1 }]} returnKeyType="go" onSubmitEditing={() => { if (!loginDisabled) void submit(); }}/>
            <Pressable accessibilityRole="button" accessibilityLabel={showPassword ? copy.hidePassword : copy.showPassword} accessibilityState={{ checked: showPassword }} disabled={busy} onPress={() => setShowPassword(value => !value)} style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}><Icon name={showPassword ? 'eyeOff' : 'eye'} color={palette.muted} size={20}/></Pressable>
          </View>
        </View>
        {!!error && <Text accessibilityRole="alert" style={styles.error}>{errorText}</Text>}
        <View style={styles.passFooter}><Text style={styles.submitLabel}>{busy ? copy.working : copy.signIn}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel={copy.signIn} accessibilityState={{ disabled: !!loginDisabled, busy }} disabled={!!loginDisabled} onPress={() => void submit()} style={({ pressed }) => [styles.enter, { backgroundColor: palette.button, opacity: loginDisabled ? .55 : pressed ? .75 : 1 }]}>
            {busy ? <ActivityIndicator color={palette.onButton}/> : <Icon name="arrowRight" color={palette.onButton} size={28}/>}
          </Pressable>
        </View>
      </View>
    </ScrollView>
  </View>;
  return <View style={{ flex: 1, backgroundColor: palette.bg }}><SignInBackground /><ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.wrap} keyboardDismissMode="on-drag" automaticallyAdjustKeyboardInsets>
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
      {state === 'password' && <>
        <Text style={styles.label}>{copy.newPassword}</Text><TextInput accessibilityLabel={copy.newPassword} secureTextEntry autoCapitalize="none" autoCorrect={false} maxLength={128} autoComplete="new-password" value={password} onChangeText={setPassword} style={styles.input} editable={!busy}/>
        <Text style={styles.body}>{copy.passwordHelp}</Text><Text style={styles.label}>{copy.confirmation}</Text><TextInput accessibilityLabel={copy.confirmation} secureTextEntry autoCapitalize="none" autoCorrect={false} maxLength={128} value={confirmation} onChangeText={setConfirmation} style={styles.input} editable={!busy}/>
      </>}
      {state === 'enroll' && <>
        <Text style={styles.body}>{copy.enrollHelp}</Text>{step?.qr && <Image accessibilityLabel={copy.qrAlt} source={{ uri: step.qr }} style={styles.qr}/>}
        <Text style={styles.label}>{copy.manualKey}</Text><Text selectable style={styles.key}>{step?.secret}</Text>
      </>}
      {(state === 'enroll' || state === 'mfa') && <><Text style={styles.label}>{state === 'enroll' ? copy.code : copy.codeOrRecovery}</Text><TextInput accessibilityLabel={state === 'enroll' ? copy.code : copy.codeOrRecovery} autoCapitalize="characters" autoCorrect={false} autoComplete="one-time-code" maxLength={64} value={code} onChangeText={setCode} style={styles.input} editable={!busy}/></>}
      <Button title={busy ? copy.working : copy.continue} onPress={() => void submit()} disabled={busy || (state === 'password' && (!password || !confirmation)) || ((state === 'enroll' || state === 'mfa') && !code)}/>
      {step && <Button title={copy.back} kind="quiet" disabled={busy} onPress={() => { beginSignIn(); owner.current = null; setStep(null); setPassword(''); setCode(''); setError(''); }}/>}
    </View>}
    <Button title={companyCopy().change} kind="quiet" disabled={busy} onPress={() => router.push('/company')}/>
  </ScrollView></View>;
}
const signInStyles = (palette: { bg: string; card: string; text: string; muted: string; border: string; accent: string }) => StyleSheet.create({
  entry: { flexGrow: 1, paddingHorizontal: 24, gap: 20, width: '100%', maxWidth: 520, alignSelf: 'center' },
  entryHeader: { flexDirection: 'row', alignItems: 'center', gap: 12, justifyContent: 'space-between', flexWrap: 'wrap' },
  wordmark: { color: palette.text, fontSize: 28, fontWeight: '700', letterSpacing: -.7 },
  workplace: { minHeight: 44, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16, flexDirection: 'row', gap: 6, alignItems: 'center', maxWidth: '100%' },
  workplaceText: { color: palette.text, fontSize: 13, flexShrink: 1 },
  entryTitle: { color: palette.text, fontSize: 48, fontWeight: '400', letterSpacing: -1.4 },
  pass: { backgroundColor: palette.card, padding: 22, gap: 14, borderRadius: 26, borderCurve: 'continuous', boxShadow: '0px 8px 28px rgba(0,0,0,0.14)' },
  passField: { borderBottomWidth: 1, borderColor: palette.border, gap: 2 },
  fieldHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' },
  passInput: { minHeight: 48, fontSize: 19, color: palette.text, paddingVertical: 10, paddingHorizontal: 0 },
  recovery: { color: palette.accent, fontSize: 13, fontWeight: '500', textDecorationLine: 'underline' },
  submitLabel: { flex: 1, color: palette.text, fontSize: 16, fontWeight: '500' },
  passFooter: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingTop: 4 },
  enter: { minWidth: 60, minHeight: 60, borderRadius: 30, alignItems: 'center', justifyContent: 'center', boxShadow: 'inset 0px 1px 2px rgba(255,255,255,0.45), 0px 3px 5px rgba(0,0,0,0.18)' },
  wrap: { flexGrow: 1, justifyContent: 'center', padding: 24, paddingTop: 72, paddingBottom: 40, gap: 24, width: '100%', maxWidth: 520, alignSelf: 'center' },
  brand: { color: palette.text, fontSize: 20, fontWeight: '700', textAlign: 'center', marginBottom: 16 }, title: { fontSize: 34, fontWeight: '700', letterSpacing: -0.7, color: palette.text, textAlign: 'center' },
  body: { color: palette.muted, fontSize: 15, lineHeight: 23 }, label: { color: palette.text, fontSize: 14, fontWeight: '500', marginTop: 4 }, fields: { gap: 12 }, input: { minHeight: 56, borderWidth: 1, borderColor: palette.border, borderRadius: 28, backgroundColor: palette.card, paddingVertical: 14, paddingHorizontal: 20, color: palette.text, fontSize: 16 },
  error: { color: palette.text, fontSize: 15 }, key: { color: palette.text, fontFamily: 'monospace', fontSize: 15, padding: 12, backgroundColor: palette.card }, codes: { color: palette.text, fontFamily: 'monospace', fontSize: 12, lineHeight: 28 }, qr: { width: 224, height: 224, alignSelf: 'center', backgroundColor: '#fff' } });
