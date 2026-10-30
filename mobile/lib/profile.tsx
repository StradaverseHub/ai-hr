/**
 * M13 (D14) — the employee's own profile: the simple personal and contact fields the employer shows, the way to
 * request a change (mobile/lib/profile-edit.tsx), and the status of every change request.
 *
 * The app decides nothing. Which fields appear, their values, whether each can be changed and why not, whether a
 * change is saved at once or waits for HR, and every request's status come from the server
 * (lib/mobile-api/v2/profile.ts; core/mobile-profile.ts composes the web's own owners). Addresses and the family,
 * bank and statutory registers are changed on the web: the server sends the web paths, opened on the connected
 * company's own origin only. Nothing is persisted on the phone (D10); offline keeps what was shown, labelled stale.
 */
import type { ReactNode } from 'react';
import { Linking, Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { DesignText as Text, useTenantDesign } from './design';
import { useApi, useApiV2 } from './api';
import { config } from './config';
import { appLocale, t, type MessageKey, intlLocale } from './i18n';
import { useSession } from './session';
import { Button, Card, LoadState, Muted, Screen, SectionLabel, Title } from './ui';
import {
  ProfileRequestsResult, ProfileWorkspaceResult,
  type ProfileCommandRefusal, type ProfileCommandRefusalCode, type ProfileFieldV2, type ProfileRequestStatus, type ProfileRequestV2,
} from '../../lib/mobile-api/v2/profile';

export const PROFILE_PATH = 'v2/profile' as const;
export const PROFILE_REQUESTS_PATH = 'v2/profile/requests' as const;
export const PROFILE_CHANGES_PATH = 'v2/profile/changes' as const;

/** A server-given relative web path, opened on the connected company's own origin only (as approval-decision.tsx). */
export function profileWebUrl(path: string | null): string | null {
  return path && config.apiUrl && /^\/(?!\/)[^\s\\]*$/.test(path) ? config.apiUrl + path : null;
}
function openOnWeb(path: string | null) {
  const url = profileWebUrl(path);
  if (url) void Linking.openURL(url).catch(() => {});
}

const REFUSAL: Record<ProfileCommandRefusalCode, MessageKey> = {
  not_found: 'profileNotFound', not_simple: 'profileRefusalNotSimple', employment_closed: 'profileReadOnlyEmployment',
  field_closed: 'profileRefusalFieldClosed', stale: 'profileRefusalStale', invalid: 'profileRefusalInvalid',
  unavailable: 'profileRefusalUnavailable', no_change: 'profileRefusalNoChange', request_conflict: 'profileRefusalConflict',
};
export function profileRefusalText(r: ProfileCommandRefusal): string { return t(REFUSAL[r.code]); }
const STATUS: Record<ProfileRequestStatus, MessageKey> = { pending: 'profileStatusPending', approved: 'profileStatusApproved', rejected: 'profileStatusRejected' };

/** What a value reads as: a choice's label, else the stored value; "Not recorded" for none. */
export function profileValueText(field: ProfileFieldV2, value: string | null): string {
  if (value === null || value === '') return t('profileNotRecorded');
  return field.options?.find((o) => o.value === value)?.label ?? value;
}
export type ProfileFieldGroup = { key: string; title: string; fields: ProfileFieldV2[] };
/**
 * The fields grouped as the web's My Profile groups them (the server's `group`), in the server's order. A server that
 * predates `group` falls back to the coarse personal/contact sections, personal first, as before.
 */
export function profileFieldGroups(fields: readonly ProfileFieldV2[]): ProfileFieldGroup[] {
  const legacy: Record<ProfileFieldV2['section'], MessageKey> = { personal: 'profilePersonal', contact: 'profileContact' };
  const ordered = fields.some((f) => f.group) ? fields : [...fields.filter((f) => f.section === 'personal'), ...fields.filter((f) => f.section !== 'personal')];
  const out: ProfileFieldGroup[] = [];
  for (const f of ordered) {
    const key = f.group?.key ?? `section:${f.section}`;
    let group = out.find((g) => g.key === key);
    if (!group) { group = { key, title: f.group?.title ?? t(legacy[f.section]), fields: [] }; out.push(group); }
    group.fields.push(f);
  }
  return out;
}
/**
 * A field's label where it is read OUTSIDE its group (a confirmation, a saved/refused list, an accessibility label):
 * qualified with the group title when another shown field carries the same label, so the two phones stay distinct.
 */
export function profileFieldLabel(field: ProfileFieldV2, fields: readonly ProfileFieldV2[]): string {
  const title = field.group?.title;
  return title && fields.some((other) => other.fieldId !== field.fieldId && other.label === field.label) ? `${field.label} — ${title}` : field.label;
}
export function fmtProfileInstant(iso: string | null): string {
  if (!iso) return '';
  try { return new Intl.DateTimeFormat(intlLocale(), { timeZone: 'Asia/Kuala_Lumpur', day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(iso)); }
  catch { return iso.slice(0, 10); }
}

/** The caller's own profile, read fresh for the selected employment. */
export function useProfileWorkspace() {
  const { signOut, employmentId } = useSession();
  return useApiV2(PROFILE_PATH, ProfileWorkspaceResult, { employmentId: employmentId ?? undefined }, signOut);
}

/** Web-only parts as rows that open the company's own web app (server paths on the connected origin only). */
function WebLinks({ web }: { web: { addresses: string | null; family: string | null; bankStatutory: string | null } }) {
  const links: [string | null, MessageKey][] = [[web.addresses, 'profileWebAddresses'], [web.family, 'profileWebFamily'], [web.bankStatutory, 'profileWebBankStatutory']];
  const shown = links.filter(([path]) => profileWebUrl(path) !== null);
  if (!shown.length) return null;
  return <View style={{ gap: 8 }}>
    <Muted>{t('profileOnWebNote')}</Muted>
    <Group>{shown.map(([path, key], i) => <NavRow key={key} first={i === 0} icon="arrow" label={t(key)} accessibilityLabel={`${t('openOnWeb')}: ${t(key)}`} onPress={() => openOnWeb(path)} />)}</Group>
  </View>;
}

/** A rounded group of rows, the iOS Settings pattern the Me tab uses. */
function Group({ children }: { children: ReactNode }) {
  const { palette, design } = useTenantDesign();
  const radius = design.schemaVersion === 2 ? design.composition.layout.radius : design.corners === 'soft' ? 18 : 4;
  return <View style={{ borderRadius: radius, backgroundColor: palette.card, borderWidth: 1, borderColor: palette.border, overflow: 'hidden' }}>{children}</View>;
}
function NavRow({ label, onPress, icon, first, accessibilityLabel }: { label: string; onPress: () => void; icon: 'arrow' | 'chevron'; first: boolean; accessibilityLabel?: string }) {
  const { palette } = useTenantDesign();
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? label} onPress={onPress}
    style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52, paddingHorizontal: 16, borderTopWidth: first ? 0 : 1, borderColor: palette.border }, pressed && { opacity: 0.6 }]}>
    <Text style={{ color: palette.text, fontSize: 16, flex: 1 }}>{label}</Text>
    <Text style={{ color: palette.muted, fontSize: icon === 'arrow' ? 16 : 20 }}>{icon === 'arrow' ? '↗' : '›'}</Text>
  </Pressable>;
}
/** One field: its label small and muted, its value as the line you read; a pending change marked beside it. */
function FieldRow({ field, first }: { field: ProfileFieldV2; first: boolean }) {
  const { palette } = useTenantDesign();
  const empty = field.value === null || field.value === '';
  return <View accessible accessibilityLabel={`${field.label}: ${profileValueText(field, field.value)}${field.pending ? `. ${t('profilePendingNote')}` : ''}`}
    style={{ paddingHorizontal: 16, paddingVertical: 12, gap: 3, borderTopWidth: first ? 0 : 1, borderColor: palette.border }}>
    <Text style={{ color: palette.muted, fontSize: 13 }}>{field.label}</Text>
    <Text selectable style={{ color: empty ? palette.muted : palette.text, fontSize: 16, fontWeight: empty ? '400' : '500', fontStyle: empty ? 'italic' : 'normal' }}>{profileValueText(field, field.value)}</Text>
    {field.pending && <View style={{ alignSelf: 'flex-start', marginTop: 4, paddingHorizontal: 10, paddingVertical: 3, borderRadius: 999, backgroundColor: tintOf(palette.accent, 0.14, palette.bg) }}>
      <Text style={{ color: palette.accent, fontSize: 12, fontWeight: '700' }}>{t('profilePendingNote')}</Text>
    </View>}
  </View>;
}
const tintOf = (c: string, a: number, fallback: string) => /^#[0-9a-f]{6}$/i.test(c) ? c + Math.round(a * 255).toString(16).padStart(2, '0') : fallback;
const initialsOf = (name: string | null | undefined) => (name ?? '').trim().split(/\s+/).filter(Boolean).map((w) => w[0]!.toUpperCase()).slice(0, 2).join('') || '·';

/**
 * My profile (redesigned, Mobile WOW round): who I am at the top (initials, name, role and company, email), each of the
 * web's field groups as a rounded card of label-over-value rows with any pending change marked on the row, then the
 * actions (request a change, my change requests) and the web-only parts as rows. What is shown, editable or pending is
 * still entirely the server's.
 */
export function ProfileScreen() {
  const { palette } = useTenantDesign();
  const { signOut, employmentId } = useSession();
  const profile = useProfileWorkspace();
  const me = useApi('me', {}, signOut);
  const workspace = profile.data?.outcome === 'found' ? profile.data.workspace : null;
  const person = me.data?.person;
  const employment = me.data?.employments.find((e) => e.employmentId === employmentId) ?? me.data?.employments[0];
  const pendingCount = workspace?.fields.filter((f) => f.pending).length ?? 0;
  const editable = !!workspace?.fields.some((f) => f.editable);
  return <Screen back refreshing={profile.loading && profile.data != null} onRefresh={() => { profile.reload(); me.reload(); }}>
    <View style={{ alignItems: 'center', gap: 6, paddingTop: 4, paddingBottom: 8 }}>
      <View style={{ width: 88, height: 88, borderRadius: 44, backgroundColor: palette.button, alignItems: 'center', justifyContent: 'center', marginBottom: 6 }}>
        <Text style={{ color: palette.onButton, fontSize: 32, fontWeight: '800' }}>{initialsOf(person?.name)}</Text>
      </View>
      <Text accessibilityRole="header" style={{ color: palette.text, fontSize: 24, fontWeight: '800', textAlign: 'center' }}>{person?.name ?? t('profileTitle')}</Text>
      {employment && <Text style={{ color: palette.muted, fontSize: 15, textAlign: 'center' }}>{[employment.position, employment.company].filter(Boolean).join(' · ')}</Text>}
      {person?.email && <Text selectable style={{ color: palette.muted, fontSize: 14, textAlign: 'center' }}>{person.email}</Text>}
      {pendingCount > 0 && <View style={{ marginTop: 6, paddingHorizontal: 12, paddingVertical: 5, borderRadius: 999, backgroundColor: tintOf(palette.accent, 0.14, palette.card) }}>
        <Text style={{ color: palette.accent, fontSize: 13, fontWeight: '700' }}>{t('profilePendingNote')}</Text>
      </View>}
    </View>
    <LoadState loading={profile.loading} hasData={profile.data != null} error={profile.error} onRetry={profile.reload} />
    {profile.data?.outcome === 'refused' && <Muted>{t(profile.data.code === 'unavailable' ? 'profileUnavailable' : 'profileNotFound')}</Muted>}
    {workspace && <>
      {editable && <Button title={t('profileRequestChange')} onPress={() => router.push('/profile/edit')} />}
      {profileFieldGroups(workspace.fields).map((group) => <View key={group.key} style={{ gap: 8 }}>
        <SectionLabel>{group.title}</SectionLabel>
        <Group>{group.fields.map((f, i) => <FieldRow key={f.fieldId} field={f} first={i === 0} />)}</Group>
      </View>)}
      {!workspace.fields.length && <Muted>{t('profileNothingShown')}</Muted>}
      {!editable && workspace.fields.length > 0 && <Muted>{t(workspace.fields.every((f) => f.readOnlyReason === 'employment_closed') ? 'profileReadOnlyEmployment' : 'profileNoEditable')}</Muted>}
      <Group><NavRow first icon="chevron" label={t('profileRequestsOpen')} onPress={() => router.push('/profile/requests')} /></Group>
      <WebLinks web={workspace.web} />
    </>}
  </Screen>;
}

function RequestCard({ item }: { item: ProfileRequestV2 }) {
  const { palette } = useTenantDesign();
  return <Card>
    <Text style={{ color: palette.text, fontSize: 16, fontWeight: '600' }}>{t(STATUS[item.status])}</Text>
    <Muted>{t('profileSubmittedOn', { date: fmtProfileInstant(item.submittedAt) })}{item.decidedAt ? ` · ${t('profileDecidedOn', { date: fmtProfileInstant(item.decidedAt) })}` : ''}</Muted>
    {item.lines.map((line) => <View key={line.key} style={{ gap: 2 }}>
      <Text style={{ color: palette.text, lineHeight: 22 }}>{t('profileLineChange', { label: line.label, proposed: line.proposed })}</Text>
      {line.current !== null && <Muted>{t('profileLineCurrent', { current: line.current })}</Muted>}
    </View>)}
    {item.decisionReason && <Muted>{t('profileDecisionReason', { reason: item.decisionReason })}</Muted>}
  </Card>;
}

/** Every own change request, newest first: waiting, approved or rejected, with the reviewer's note. */
export function ProfileRequestsScreen() {
  const { signOut, employmentId } = useSession();
  const list = useApiV2(PROFILE_REQUESTS_PATH, ProfileRequestsResult, { employmentId: employmentId ?? undefined }, signOut);
  const requests = list.data?.outcome === 'found' ? list.data.requests : null;
  return <Screen back refreshing={list.loading && list.data != null} onRefresh={list.reload}>
    <Title>{t('profileRequestsTitle')}</Title>
    <LoadState loading={list.loading} hasData={list.data != null} error={list.error} onRetry={list.reload} />
    {list.data?.outcome === 'refused' && <Muted>{t(list.data.code === 'unavailable' ? 'profileUnavailable' : 'profileNotFound')}</Muted>}
    {requests && <>
      {requests.web === null && <Muted>{t('profileRequestsHidden')}</Muted>}
      {requests.web !== null && !requests.items.length && <Muted>{t('profileRequestsEmpty')}</Muted>}
      {requests.items.map((item) => <RequestCard key={item.id} item={item} />)}
      {requests.truncated && <Muted>{t('profileRequestsTruncated')}</Muted>}
      {profileWebUrl(requests.web) && <Button title={t('profileWebRequests')} accessibilityLabel={`${t('openOnWeb')}: ${t('profileWebRequests')}`} kind="quiet" onPress={() => openOnWeb(requests.web)} />}
    </>}
  </Screen>;
}
