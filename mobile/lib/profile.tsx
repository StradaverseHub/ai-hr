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
import { Linking, View } from 'react-native';
import { router } from 'expo-router';
import { DesignText as Text, useTenantDesign } from './design';
import { useApiV2 } from './api';
import { config } from './config';
import { appLocale, t, type MessageKey } from './i18n';
import { useSession } from './session';
import { Button, Card, LoadState, Muted, Row, Screen, SectionLabel, Title } from './ui';
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
  try { return new Intl.DateTimeFormat(appLocale() === 'ms' ? 'ms-MY' : 'en-MY', { timeZone: 'Asia/Kuala_Lumpur', day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(iso)); }
  catch { return iso.slice(0, 10); }
}

/** The caller's own profile, read fresh for the selected employment. */
export function useProfileWorkspace() {
  const { signOut, employmentId } = useSession();
  return useApiV2(PROFILE_PATH, ProfileWorkspaceResult, { employmentId: employmentId ?? undefined }, signOut);
}

function WebLinks({ web }: { web: { addresses: string | null; family: string | null; bankStatutory: string | null } }) {
  const links: [string | null, MessageKey][] = [[web.addresses, 'profileWebAddresses'], [web.family, 'profileWebFamily'], [web.bankStatutory, 'profileWebBankStatutory']];
  const shown = links.filter(([path]) => profileWebUrl(path) !== null);
  if (!shown.length) return null;
  return <Card>
    <Muted>{t('profileOnWebNote')}</Muted>
    {shown.map(([path, key]) => <Button key={key} title={t(key)} accessibilityLabel={`${t('openOnWeb')}: ${t(key)}`} kind="quiet" onPress={() => openOnWeb(path)} />)}
  </Card>;
}

/** My profile: the simple fields as the server shows them, a pending-change note, and where everything else lives. */
export function ProfileScreen() {
  const { palette } = useTenantDesign();
  const profile = useProfileWorkspace();
  const workspace = profile.data?.outcome === 'found' ? profile.data.workspace : null;
  return <Screen back refreshing={profile.loading && profile.data != null} onRefresh={profile.reload}>
    <Title>{t('profileTitle')}</Title>
    <LoadState loading={profile.loading} hasData={profile.data != null} error={profile.error} onRetry={profile.reload} />
    {profile.data?.outcome === 'refused' && <Muted>{t(profile.data.code === 'unavailable' ? 'profileUnavailable' : 'profileNotFound')}</Muted>}
    {workspace && <>
      {profileFieldGroups(workspace.fields).map((group) => <View key={group.key} style={{ gap: 8 }}>
        <SectionLabel>{group.title}</SectionLabel>
        <Card>{group.fields.map((f) => <View key={f.fieldId} style={{ gap: 2 }}>
          <Row label={f.label} value={profileValueText(f, f.value)} />
          {f.pending && <Text style={{ color: palette.accent, fontSize: 14 }}>{t('profilePendingNote')}</Text>}
        </View>)}</Card>
      </View>)}
      {!workspace.fields.length && <Muted>{t('profileNothingShown')}</Muted>}
      {workspace.fields.some((f) => f.editable) && <Button title={t('profileRequestChange')} onPress={() => router.push('/profile/edit')} />}
      {!workspace.fields.some((f) => f.editable) && workspace.fields.length > 0 && <Muted>{t(workspace.fields.every((f) => f.readOnlyReason === 'employment_closed') ? 'profileReadOnlyEmployment' : 'profileNoEditable')}</Muted>}
      <Button title={t('profileRequestsOpen')} kind="quiet" onPress={() => router.push('/profile/requests')} />
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
