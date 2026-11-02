/** Native views/OS dialogs are ports; shipped form logic, contracts and caller-supplied API routes stay real. */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { transpileModule, ModuleKind, JsxEmit, ScriptTarget } from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, vi } from 'vitest';
import * as taskContract from '../../lib/mobile-api/v2/tasks';
import * as requestContract from '../../lib/mobile-api/v2/request-workspaces';
import * as reviewContract from '../../lib/mobile-api/v2/review-workspaces';
import * as packContract from '../../lib/mobile-api/v2/pack-workspaces';
import { DEFAULT_MOBILE_DESIGN } from '../../lib/mobile-design';
import * as errors from '../../mobile/lib/errors';

export type Family = 'tasks' | 'request-workspaces' | 'review-workspaces' | 'pack-workspaces';
export function nativeApiJourney(options: {
  family: Family; kind: string; id: string; reply: unknown;
  decide: (body: Record<string, unknown>) => Promise<unknown>;
  loseFirstReply?: boolean;
}) {
  const alert = vi.fn(), reload = vi.fn(), signOut = vi.fn();
  const sent: Record<string, unknown>[] = [], answers: unknown[] = [];
  const View = ({ children }: any) => <div>{children}</div>;
  const Text = ({ children }: any) => <span>{children}</span>;
  const Button = ({ title, disabled, onPress, accessibilityLabel }: any) => <button aria-label={accessibilityLabel} disabled={disabled} onClick={onPress}>{title}</button>;
  const native = {
    View, Image: () => null, TextInput: ({ accessibilityLabel, value, onChangeText, editable }: any) => <input aria-label={accessibilityLabel} value={value ?? ''} disabled={editable === false} onChange={e => onChangeText(e.target.value)} />,
    Pressable: ({ children, onPress, accessibilityLabel, accessibilityRole, accessibilityState, disabled }: any) => <button role={accessibilityRole} aria-label={accessibilityLabel} aria-checked={accessibilityState?.checked} disabled={disabled} onClick={onPress}>{typeof children === 'function' ? children({ pressed: false }) : children}</button>,
    FlatList: ({ data, renderItem, ListHeaderComponent, ListFooterComponent }: any) => <div>{ListHeaderComponent}{data.map((item: any) => <div key={item.id}>{renderItem({ item })}</div>)}{ListFooterComponent}</div>,
    Linking: { openURL: vi.fn() },
  };
  const api = {
    v2Page: () => ({}), v2Download: () => ({}), apiDownload: vi.fn(),
    apiGetV2: async (_path: string, schema: any) => schema.parse(options.reply),
    useApiV2: (_path: string, schema: any) => ({ data: schema.parse(options.reply), error: null, loading: false, reload }),
    apiPostV2: async (path: string, schema: any, body: Record<string, unknown>) => {
      expect(path).toBe(`v2/${options.family}/${options.kind}/${options.id}/decision`);
      sent.push(structuredClone(body));
      const answer = schema.parse(await options.decide(body));
      answers.push(answer);
      // Deliberately lose the first *committed* answer; the actual server receipt must replay on Retry.
      if (options.loseFirstReply && sent.length === 1) throw new errors.UnavailableError();
      return answer;
    },
  };
  const ui = {
    Button, Chip: Button, Card: View, Muted: Text, Title: Text, Row: ({ label, value }: any) => <p>{label}: {value}</p>,
    Screen: ({ children, footer }: any) => <div>{children}{footer}</div>, HeaderBack: () => <button>Back</button>, LoadState: () => null,
    fmtDays: (n: unknown) => `${n} days`, fmtMoney: (n: unknown) => String(n),
  };
  const ports: Record<string, unknown> = {
    react: React, 'react/jsx-runtime': jsx, 'react-native': native,
    'react-native-safe-area-context': { SafeAreaView: View },
    'expo-router': { router: { replace: vi.fn(), push: vi.fn() }, Redirect: () => null, useFocusEffect: (fn: () => (() => void)) => React.useEffect(fn, [fn]) },
    'expo-crypto': { randomUUID }, './api': api, './auth': { authGeneration: () => 1, assertAuthGeneration: () => {} },
    './session': { useSession: () => ({ status: 'signedIn', employmentId: null, signOut }) },
    './errors': errors, './config': { config: { apiUrl: 'https://hr.test' }, identityNamespace: () => 'isolated-fixture' },
    './design': { DesignText: Text, Atmosphere: () => null, useTenantDesign: () => ({ design: DEFAULT_MOBILE_DESIGN, palette: { text: '#fff', border: '#333', muted: '#aaa' } }) },
    './visual': { Material: View, StatusPill: Text, alpha: (v: string) => v }, './icon': { Icon: () => null },
    './i18n': { t: (key: string) => key, appLocale: () => 'en' }, './ui': ui,
    './in-app-alert': { InAppAlert: { alert } }, './approval-document': { ApprovalDocument: ({ name }: any) => <p>{name}</p> },
    './paged-list': { PagedList: () => null, usePagedResource: () => ({}) },
    './leave-request-form': { PickerField: ({ label, value, onChange, disabled }: any) => <input aria-label={label} value={value ?? ''} disabled={disabled} onChange={e => onChange(e.target.value)} /> },
    '../../lib/mobile-api/v2/tasks': taskContract, '../../lib/mobile-api/v2/request-workspaces': requestContract,
    '../../lib/mobile-api/v2/review-workspaces': reviewContract, '../../lib/mobile-api/v2/pack-workspaces': packContract,
  };
  function load(file: string): any {
    const module = { exports: {} };
    runInNewContext(transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX, target: ScriptTarget.ES2022 } }).outputText,
      { module, exports: module.exports, Date, Error, Object, Number, Map, Set, AbortController, require: (key: string) => { if (key in ports) return ports[key]; throw new Error(`Missing native test port ${key}`); } });
    return module.exports;
  }
  ports['./request-workspace-copy'] = load('mobile/lib/request-workspace-copy.ts');
  ports['./review-workspace-copy'] = load('mobile/lib/review-workspace-copy.ts');
  const files = { tasks: ['approval-decision', 'ApprovalDetailScreen'], 'request-workspaces': ['request-workspace', 'RequestWorkspaceScreen'], 'review-workspaces': ['review-workspace', 'ReviewWorkspaceScreen'], 'pack-workspaces': ['pack-workspace', 'PackWorkspaceScreen'] } as const;
  const [file, exported] = files[options.family], Component = load(`mobile/lib/${file}.tsx`)[exported];
  const tree = render(<Component kind={options.kind} id={options.id} />);
  async function confirm() {
    await waitFor(() => expect(alert).toHaveBeenCalledTimes(1), { timeout: 10000 });
    expect(sent).toHaveLength(0);
    // This is the OS dialog port; Android's actual same-window renderer has separate live and DOM evidence.
    await act(async () => { alert.mock.calls[0][2][1].onPress(); });
    if (options.loseFirstReply) {
      await waitFor(() => expect(screen.getByRole('button', { name: 'approvalRetry' })).toBeTruthy(), { timeout: 10000 });
      fireEvent.click(screen.getByRole('button', { name: 'approvalRetry' }));
    }
    await waitFor(() => expect(answers).toHaveLength(options.loseFirstReply ? 2 : 1), { timeout: 10000 });
    if (options.loseFirstReply) { expect(sent[1]).toEqual(sent[0]); expect(answers[1]).toEqual(answers[0]); }
    expect(signOut).not.toHaveBeenCalled();
  }
  return { tree, alert, sent, answers, confirm, requestCopy: (ports['./request-workspace-copy'] as any).requestCopy(), reviewCopy: (ports['./review-workspace-copy'] as any).reviewCopy() };
}
