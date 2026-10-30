/**
 * M13 (D14) — request a change to the simple personal and contact fields. The form is the server's: only fields it
 * marks editable take input, read-only ones say why, and each says whether it is saved at once or waits for HR.
 *
 * STALE VALUES. A field's server `baseline` is captured the moment it is first edited and sent back as `before`; if
 * the value changed on the server since (another device, HR), the server refuses `stale` instead of overwriting it,
 * and the app drops those edits so they are entered again against the current value.
 *
 * ONLINE ONLY, CONFIRMED, IN MEMORY (D10). Nothing is queued or persisted. A send needs a fresh answer from the
 * server, runs only after a confirmation that repeats every change, and carries a client requestId the server's
 * command receipt replays: when the answer is lost, "Try again" resends the SAME reference and the change is never
 * applied twice. Only CHANGED fields are sent.
 */
import { useEffect, useRef, useState } from 'react';
import { Alert, Platform, Pressable, TextInput, View } from 'react-native';
import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { router } from 'expo-router';
import { randomUUID } from 'expo-crypto';
import { DesignText as Text, useTenantDesign } from './design';
import { apiPostV2 } from './api';
import { assertAuthGeneration, authGeneration } from './auth';
import { RequestRejectedError, SignInRequiredError } from './errors';
import { t } from './i18n';
import { useSession } from './session';
import { Button, Card, LoadState, Muted, Row, Screen, SectionLabel, Title } from './ui';
import { PROFILE_CHANGES_PATH, profileFieldGroups, profileFieldLabel, profileRefusalText, profileValueText, useProfileWorkspace } from './profile';
import { ProfileChangeResult, type ProfileChangeCommand, type ProfileFieldV2 } from '../../lib/mobile-api/v2/profile';

type Draft = Record<string, { value: string | null; before: string }>;
const pad = (n: number) => String(n).padStart(2, '0');
/** A calendar date is the device's LOCAL wall value the person picked; it never passes through UTC. */
const toPicker = (value: string | null) => {
  if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) { const [y, m, d] = value.split('-').map(Number); return new Date(y, m - 1, d); }
  return new Date();
};
const fromPicker = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** D9 — the platform date control (Android dialog; iOS spinner committed with Done). */
function DateField({ label, value, disabled, onChange }: { label: string; value: string | null; disabled: boolean; onChange: (value: string) => void }) {
  const [open, setOpen] = useState<Date | null>(null);
  function show() {
    if (disabled) return;
    const seed = toPicker(value);
    if (Platform.OS === 'android') DateTimePickerAndroid.open({ value: seed, mode: 'date', onChange: (event, picked) => { if (event.type === 'set' && picked) onChange(fromPicker(picked)); } });
    else setOpen(open ? null : seed);
  }
  return <View style={{ gap: 6 }}>
    <Button title={value || t('profileChoose')} accessibilityLabel={label} kind="quiet" disabled={disabled} onPress={show} />
    {open && Platform.OS !== 'android' && <>
      <DateTimePicker accessibilityLabel={label} value={open} mode="date" display="spinner" onChange={(_event, picked) => { if (picked) setOpen(picked); }} />
      <Button title={t('pickerDone')} onPress={() => { onChange(fromPicker(open)); setOpen(null); }} />
    </>}
  </View>;
}

/** One of the server's options; a long list can be narrowed by typing. */
function ChoiceField({ field, label, value, disabled, onChange }: { field: ProfileFieldV2; label: string; value: string | null; disabled: boolean; onChange: (value: string) => void }) {
  const { palette, design } = useTenantDesign();
  const [open, setOpen] = useState(false), [query, setQuery] = useState('');
  const options = field.options ?? [];
  const current = profileValueText(field, value);
  const q = query.trim().toLowerCase();
  const shown = (q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options).slice(0, 100);
  const radius = design.schemaVersion === 2 ? design.composition.layout.radius : design.corners === 'soft' ? 12 : 4;
  return <View style={{ gap: 6 }}>
    <Button title={current} accessibilityLabel={`${label}: ${current}`} kind="quiet" disabled={disabled} onPress={() => setOpen(!open)} />
    {open && !disabled && <View style={{ gap: 4 }}>
      {options.length > 12 && <TextInput accessibilityLabel={t('profileSearch')} placeholder={t('profileSearch')} value={query} onChangeText={setQuery} autoCorrect={false}
        placeholderTextColor={palette.muted} style={{ color: palette.text, minHeight: 48, borderWidth: 1, borderColor: palette.border, borderRadius: radius, padding: 12, fontSize: 16 }} />}
      {shown.map((o) => <Pressable key={o.value} accessibilityRole="radio" accessibilityLabel={o.label} accessibilityState={{ checked: o.value === value }}
        onPress={() => { onChange(o.value); setOpen(false); setQuery(''); }} style={{ minHeight: 44, justifyContent: 'center' }}>
        <Text style={{ color: o.value === value ? palette.accent : palette.text, fontSize: 16 }}>{o.label}</Text>
      </Pressable>)}
      {value !== null && !options.some((o) => o.value === value) && <Muted>{t('profileRecordedValue', { value })}</Muted>}
    </View>}
  </View>;
}

/** `label` is the field's label as read out of its group (profileFieldLabel): what assistive technology announces. */
function FieldEditor({ field, label, draft, disabled, onEdit, onUndo }: { field: ProfileFieldV2; label: string; draft: Draft[string] | undefined; disabled: boolean; onEdit: (value: string | null) => void; onUndo: () => void }) {
  const { palette, design } = useTenantDesign();
  const value = draft ? draft.value : field.value;
  const radius = design.schemaVersion === 2 ? design.composition.layout.radius : design.corners === 'soft' ? 12 : 4;
  if (!field.editable) return <View style={{ gap: 2 }}>
    <Row label={field.label} value={profileValueText(field, field.value)} />
    <Muted>{t(field.readOnlyReason === 'employment_closed' ? 'profileReadOnlyEmployment' : 'profileReadOnlyField')}</Muted>
  </View>;
  return <View style={{ gap: 6 }}>
    <Text style={{ color: palette.muted, fontSize: 14 }}>{field.label}</Text>
    {field.kind === 'date' ? <DateField label={label} value={value} disabled={disabled} onChange={onEdit} />
      : field.kind === 'choice' ? <ChoiceField field={field} label={label} value={value} disabled={disabled} onChange={onEdit} />
        : <TextInput accessibilityLabel={label} editable={!disabled} value={value ?? ''} maxLength={4000} autoCorrect={false}
          autoCapitalize={field.kind === 'email' ? 'none' : 'words'} keyboardType={field.kind === 'email' ? 'email-address' : field.kind === 'phone' ? 'phone-pad' : 'default'}
          onChangeText={(text) => onEdit(text === '' ? null : text)}
          style={{ color: palette.text, minHeight: 48, borderWidth: 1, borderColor: palette.border, borderRadius: radius, padding: 12, fontSize: 16 }} />}
    <Muted>{t(field.applies === 'immediately' ? 'profileAppliesNow' : 'profileAppliesApproval')}</Muted>
    {field.pending && <Text style={{ color: palette.accent, fontSize: 14 }}>{t('profilePendingNote')}</Text>}
    <View style={{ flexDirection: 'row', gap: 8 }}>
      {!field.required && value !== null && <Button title={t('profileClear')} accessibilityLabel={`${t('profileClear')}: ${label}`} kind="quiet" disabled={disabled} onPress={() => onEdit(null)} />}
      {draft && <Button title={t('profileUndo')} accessibilityLabel={`${t('profileUndo')}: ${label}`} kind="quiet" disabled={disabled} onPress={onUndo} />}
    </View>
  </View>;
}

export function ProfileEditScreen() {
  const { palette } = useTenantDesign();
  const { signOut, employmentId } = useSession();
  const profile = useProfileWorkspace();
  const [draft, setDraft] = useState<Draft>({});
  const [command, setCommand] = useState<{ body: ProfileChangeCommand; employmentId: string; phase: 'sending' | 'uncertain' } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const flight = useRef(false);
  const workspace = profile.data?.outcome === 'found' ? profile.data.workspace : null;
  // Online only: a change needs a fresh answer from the server, never a stale copy.
  const online = !!workspace && !profile.error && !profile.loading;
  const busy = command?.phase === 'sending';
  // An edit belongs to the employment it was made on; switching employment discards it.
  useEffect(() => { setDraft({}); setCommand(null); setNotice(null); }, [employmentId]);

  function edit(field: ProfileFieldV2, value: string | null) {
    setNotice(null);
    setDraft((prev) => {
      const next = { ...prev };
      if ((value ?? null) === (field.value ?? null)) delete next[field.fieldId];
      else next[field.fieldId] = { value, before: prev[field.fieldId]?.before ?? field.baseline };
      return next;
    });
  }
  const undo = (field: ProfileFieldV2) => setDraft((prev) => { const next = { ...prev }; delete next[field.fieldId]; return next; });
  const labelOf = (id: string) => { const f = workspace?.fields.find((x) => x.fieldId === id); return f && workspace ? profileFieldLabel(f, workspace.fields) : id; };

  async function send(body: ProfileChangeCommand, target: string) {
    if (flight.current) return;
    flight.current = true; const owner = authGeneration();
    setCommand({ body, employmentId: target, phase: 'sending' }); setNotice(null);
    try {
      const result = await apiPostV2(PROFILE_CHANGES_PATH, ProfileChangeResult, body, { employmentId: target });
      assertAuthGeneration(owner);
      setCommand(null);
      if (result.outcome === 'submitted') {
        setDraft({});
        setNotice([
          result.saved.length ? t('profileSavedNow', { fields: result.saved.map(labelOf).join(', ') }) : null,
          result.waiting.length ? t('profileSentForApproval', { fields: result.waiting.map(labelOf).join(', ') }) : null,
        ].filter(Boolean).join('\n'));
      } else {
        // A stale value is entered again against the current one: drop exactly those edits (all, when unnamed).
        if (result.code === 'stale') setDraft((prev) => result.fieldIds?.length ? Object.fromEntries(Object.entries(prev).filter(([id]) => !result.fieldIds!.includes(id))) : {});
        if (result.code === 'no_change') setDraft({});
        setNotice(profileRefusalText(result) + (result.fieldIds?.length ? ` ${result.fieldIds.map(labelOf).join(', ')}` : ''));
      }
      profile.reload();
    } catch (e) {
      if (e instanceof SignInRequiredError) { setCommand(null); void signOut(); }
      // A 4xx was refused before anything was recorded; anything else may or may not have been: keep the reference.
      else if (e instanceof RequestRejectedError) { setCommand(null); setNotice(t('genericError')); profile.reload(); }
      else setCommand({ body, employmentId: target, phase: 'uncertain' });
    } finally { flight.current = false; }
  }
  function review() {
    if (!workspace) return;
    const changed = workspace.fields.filter((f) => f.editable && Object.hasOwn(draft, f.fieldId));
    if (!changed.length) { setNotice(t('profileNoChanges')); return; }
    const body: ProfileChangeCommand = { requestId: randomUUID(), changes: changed.map((f) => ({ fieldId: f.fieldId, before: draft[f.fieldId].before, value: draft[f.fieldId].value })) };
    const lines = changed.map((f) => t('profileConfirmLine', {
      label: profileFieldLabel(f, workspace.fields), from: profileValueText(f, f.value), to: profileValueText(f, draft[f.fieldId].value),
      when: t(f.applies === 'immediately' ? 'profileAppliesNow' : 'profileAppliesApproval'),
    })).join('\n');
    const target = workspace.employmentId;
    Alert.alert(t('profileConfirmTitle'), lines, [
      { text: t('cancel'), style: 'cancel' },
      { text: t('profileConfirmSend'), onPress: () => void send(body, target) },
    ]);
  }

  return <Screen back>
    <Title>{t('profileEditTitle')}</Title>
    <LoadState loading={profile.loading} hasData={profile.data != null} error={profile.error} onRetry={profile.reload} />
    {profile.data?.outcome === 'refused' && <Muted>{t(profile.data.code === 'unavailable' ? 'profileUnavailable' : 'profileNotFound')}</Muted>}
    {notice && <Text accessibilityRole="alert" style={{ color: palette.text, lineHeight: 23 }}>{notice}</Text>}
    {workspace && <>
      <Muted>{t('profileEditHint')}</Muted>
      {!online && <Muted>{t('profileNeedsConnection')}</Muted>}
      {profileFieldGroups(workspace.fields).map((group) => <View key={group.key} style={{ gap: 8 }}>
        <SectionLabel>{group.title}</SectionLabel>
        <Card>{group.fields.map((f) => <FieldEditor key={f.fieldId} field={f} label={profileFieldLabel(f, workspace.fields)} draft={draft[f.fieldId]} disabled={!online || !!command} onEdit={(v) => edit(f, v)} onUndo={() => undo(f)} />)}</Card>
      </View>)}
      {command?.phase === 'uncertain' && <Card>
        <Text accessibilityRole="alert" style={{ color: palette.text, lineHeight: 23 }}>{t('profileUncertain')}</Text>
        <Button title={t('profileRetry')} onPress={() => void send(command.body, command.employmentId)} />
        <Button title={t('profileDismiss')} kind="quiet" onPress={() => { setCommand(null); profile.reload(); }} />
      </Card>}
      {!command && <Button title={t('profileReview')} disabled={!online || busy || !Object.keys(draft).length} onPress={review} />}
      {busy && <Muted>{t('profileSending')}</Muted>}
    </>}
  </Screen>;
}
