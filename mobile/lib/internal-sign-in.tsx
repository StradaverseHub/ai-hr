import { PublicHeader } from './public-header';
import { DesignText as Text } from './design';
import { useRef, useState } from 'react';
import { fetch as nativeFetch } from 'expo/fetch';
import { TextInput, ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, View } from 'react-native';
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
import { SafeAreaView } from 'react-native-safe-area-context';
import { appLocale, t } from './i18n';
import authCopy from './internal-auth-copy.json';

export function InternalSignIn() {
  const company = useCompanyConnection(), session = useSession();
  const { palette } = useTenantDesign();
  const [showPassword, setShowPassword] = useState(false);
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
  const loginDisabled = busy || !(workplaceOrganization || organization) || !username || !password;
  if (state === 'login') return <SafeAreaView edges={['top','bottom']} style={{ flex: 1, backgroundColor: palette.bg }}><SignInBackground/><View style={styles.publicBar}><PublicHeader/></View>
    <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" automaticallyAdjustKeyboardInsets contentContainerStyle={styles.entry}>
      <Text accessibilityRole="header" style={styles.entryTitle}>{t('fieldSignInTitle')}</Text>
      <Text style={[styles.label,{fontWeight:'700'}]}>{copy.loginTitle}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={companyCopy().change} disabled={busy} onPress={() => router.push('/company')} style={[styles.workplace,{borderTopWidth:1,borderBottomWidth:1,borderColor:palette.border}]}>
        <Text style={[styles.workplaceText,{flex:1,fontWeight:'600'}]}>{company?.name || companyCopy().change}{workplaceOrganization?` · ${workplaceOrganization}`:''}</Text><Icon name="chevronDown" color={palette.accent} size={14}/>
      </Pressable>
      <Text style={styles.editorial}>{t('fieldAccountTitle')}</Text>
      <View style={styles.pass}>
        {!workplaceOrganization&&<View style={styles.passField}>
          <Text style={styles.label}>{copy.organization}</Text><TextInput accessibilityLabel={copy.organization} autoCapitalize="none" autoCorrect={false} maxLength={64} value={organization} onChangeText={setOrganization} editable={!busy} style={[{ fontFamily: 'FieldRegular' }, styles.passInput]}/>
        </View>}
        <View style={styles.passField}><Text style={styles.label}>{copy.username}</Text>
          <TextInput accessibilityLabel={copy.username} autoCapitalize="none" autoCorrect={false} autoComplete="username" textContentType="username" maxLength={64} value={username} onChangeText={setUsername} editable={!busy} style={[{ fontFamily: 'FieldRegular' }, styles.passInput]}/>
        </View>
        <View style={styles.passField}>
          <Text style={styles.label}>{copy.password}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <TextInput accessibilityLabel={copy.password} secureTextEntry={!showPassword} autoCapitalize="none" autoCorrect={false} autoComplete="current-password" textContentType="password" maxLength={128} value={password} onChangeText={setPassword} editable={!busy} style={[{ fontFamily: 'FieldRegular' }, [styles.passInput, { flex: 1 }]]} returnKeyType="go" onSubmitEditing={() => { if (!loginDisabled) void submit(); }}/>
            <Pressable accessibilityRole="button" accessibilityLabel={showPassword ? copy.hidePassword : copy.showPassword} accessibilityState={{ checked: showPassword }} disabled={busy} onPress={() => setShowPassword(value => !value)} style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}><Icon name={showPassword ? 'eyeOff' : 'eye'} color={palette.muted} size={20}/></Pressable>
          </View>
        </View>
        {!!error && <Text accessibilityRole="alert" style={styles.error}>{errorText}</Text>}
        <Button title={busy ? copy.working : copy.signIn} disabled={!!loginDisabled} onPress={() => void submit()} />
        <Pressable accessibilityRole="link" disabled={busy} onPress={() => void WebBrowser.openBrowserAsync(config.apiUrl + '/reset-password')} style={{minHeight:44,justifyContent:'center',alignItems:'center'}}><Text style={styles.recovery}>{copy.forgot}</Text></Pressable>

      </View>
    </ScrollView>
  </SafeAreaView>;
  return <SafeAreaView edges={['top','bottom']} style={{ flex: 1, backgroundColor: palette.bg }}><SignInBackground /><View style={styles.publicBar}><PublicHeader/></View><ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.wrap} keyboardDismissMode="on-drag" automaticallyAdjustKeyboardInsets>
    <Text accessibilityRole="header" style={styles.title}>{state === 'complete' && hasRecoveryCodes ? copy.codesTitle : state === 'password' ? copy.passwordTitle : state === 'enroll' ? copy.enrollTitle : state === 'mfa' ? copy.mfaTitle : copy.loginTitle}</Text>
    {company && <Text style={styles.body}>{company.name} · {new URL(company.apiOrigin).hostname}</Text>}
    {state==='mfa'&&<Text style={styles.editorial}>{t('fieldOneMoreStep')}</Text>}
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
        <Text style={styles.label}>{copy.newPassword}</Text><TextInput accessibilityLabel={copy.newPassword} secureTextEntry autoCapitalize="none" autoCorrect={false} maxLength={128} autoComplete="new-password" value={password} onChangeText={setPassword} style={[{ fontFamily: 'FieldRegular' }, styles.input]} editable={!busy}/>
        <Text style={styles.body}>{copy.passwordHelp}</Text><Text style={styles.label}>{copy.confirmation}</Text><TextInput accessibilityLabel={copy.confirmation} secureTextEntry autoCapitalize="none" autoCorrect={false} maxLength={128} value={confirmation} onChangeText={setConfirmation} style={[{ fontFamily: 'FieldRegular' }, styles.input]} editable={!busy}/>
      </>}
      {state === 'enroll' && <>
        <Text style={styles.body}>{copy.enrollHelp}</Text>{step?.qr && <Image accessibilityLabel={copy.qrAlt} source={{ uri: step.qr }} style={styles.qr}/>}
        <Text style={styles.label}>{copy.manualKey}</Text><Text selectable style={styles.key}>{step?.secret}</Text>
      </>}
      {(state === 'enroll' || state === 'mfa') && <><Text style={styles.label}>{state === 'enroll' ? copy.code : copy.codeOrRecovery}</Text><TextInput accessibilityLabel={state === 'enroll' ? copy.code : copy.codeOrRecovery} autoCapitalize="characters" autoCorrect={false} autoComplete="one-time-code" maxLength={64} value={code} onChangeText={setCode} style={[{ fontFamily: 'FieldRegular' }, styles.input]} editable={!busy}/></>}
      <Button title={busy ? copy.working : copy.continue} onPress={() => void submit()} disabled={busy || (state === 'password' && (!password || !confirmation)) || ((state === 'enroll' || state === 'mfa') && !code)}/>
      {step && <Button title={copy.back} kind="quiet" disabled={busy} onPress={() => { beginSignIn(); owner.current = null; setStep(null); setPassword(''); setCode(''); setError(''); }}/>}
    </View>}
    <Button title={companyCopy().change} kind="quiet" disabled={busy} onPress={() => router.push('/company')}/>
  </ScrollView></SafeAreaView>;
}
const signInStyles = (palette: { bg: string; card: string; text: string; muted: string; border: string; accent: string }) => StyleSheet.create({
  publicBar:{paddingHorizontal:24,paddingTop:8,width:'100%',maxWidth:520,alignSelf:'center'},
  entry: { flexGrow: 1, paddingHorizontal: 24,paddingBottom:24, gap: 14, width: '100%', maxWidth: 520, alignSelf: 'center' },
  workplace: { minHeight: 52, paddingHorizontal: 0, paddingVertical: 10, borderRadius: 0, flexDirection: 'row', gap: 6, alignItems: 'center', maxWidth: '100%' },
  workplaceText: { color: palette.text, fontSize: 13, flexShrink: 1 },
  entryTitle: { color: palette.text, fontSize: 42,lineHeight:43, fontWeight: '800', letterSpacing: -1.3 },
  pass: { paddingVertical: 0, gap: 14 },
  passField: { borderBottomWidth: 1, borderColor: palette.border, gap: 2 },
  fieldHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' },
  passInput: { minHeight: 48, fontSize: 17, color: palette.text, paddingVertical: 10, paddingHorizontal: 0 },
  recovery: { color: palette.accent, fontSize: 13, fontWeight: '500', textDecorationLine: 'underline' },
  wrap: { flexGrow: 1, padding: 24, paddingTop: 0, paddingBottom: 24, gap: 16, width: '100%', maxWidth: 520, alignSelf: 'center' },
  brand: { color: palette.text, fontSize: 20, fontWeight: '700', textAlign: 'center', marginBottom: 16 }, title: { fontSize: 40,lineHeight:42, fontWeight: '800', letterSpacing: -1, color: palette.text },
  editorial:{fontFamily:'FieldEditorial',fontWeight:'normal',fontSize:27,lineHeight:30,color:palette.text,borderBottomWidth:1,borderColor:palette.border,paddingBottom:10},
  body: { color: palette.muted, fontSize: 15, lineHeight: 23 }, label: { color: palette.text, fontSize: 14, fontWeight: '500', marginTop: 4 }, fields: { gap: 12 }, input: { minHeight: 56, borderBottomWidth: 1, borderColor: palette.border, borderRadius: 0, paddingVertical: 14, paddingHorizontal: 0, color: palette.text, fontSize: 16 },
  error: { color: palette.text, fontSize: 15, borderTopWidth: 1, borderColor: palette.border, paddingTop: 12 }, key: { color: palette.text, fontFamily: 'monospace', fontSize: 15, padding: 12, backgroundColor: palette.card }, codes: { color: palette.text, fontFamily: 'monospace', fontSize: 12, lineHeight: 28 }, qr: { width: 224, height: 224, alignSelf: 'center', backgroundColor: '#fff' } });
