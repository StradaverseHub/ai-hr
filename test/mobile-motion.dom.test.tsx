import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { JsxEmit, ModuleKind, transpileModule } from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

function fixture() {
  const design = { reduceMotion: false, palette: { button: '#c7f51c', onButton: '#111600' } };
  const View = ({ children, style }: any) => <div data-transform={JSON.stringify(Array.isArray(style) ? style.at(-1)?.transform : undefined)}>{children}</div>;
  const Text = ({ children }: any) => <span>{children}</span>;
  function Pressable(p: any) {
    const [pressed, setPressed] = React.useState(false);
    return <button aria-label={p.accessibilityLabel} disabled={p.disabled} onMouseDown={() => setPressed(true)} onMouseUp={() => setPressed(false)} onMouseLeave={() => setPressed(false)} onClick={p.onPress}>{typeof p.children === 'function' ? p.children({ pressed }) : p.children}</button>;
  }
  function load(file: string, ports: Record<string, unknown>) {
    const output = { exports: {} as any };
    runInNewContext(transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX } }).outputText,
      { module: output, exports: output.exports, require: (id: string) => {
        if (id === 'react') return React;
        if (id === 'react/jsx-runtime') return jsx;
        if (id === './design') return { useTenantDesign: () => design, DesignText: Text };
        if (id in ports) return ports[id];
        throw new Error(id);
      } });
    return output.exports;
  }
  const motion = load('mobile/lib/motion.tsx', { 'react-native-reanimated': { default: { View, ScrollView: View }, cubicBezier: () => 'ease-out' } });
  const { DailySwitch } = load('mobile/lib/daily-switch.tsx', {
    'react-native': { View, Pressable, ActivityIndicator: () => <span>busy</span> },
    './motion': motion, './icon': { Icon: () => null }, './daily-switch-theme': { DAILY_SWITCH: { ink: '#111600', edge: '#30362a' } },
     './ui': { Button: ({title,onPress,disabled}:any) => <button disabled={disabled} onClick={onPress} aria-label={title}>{title}</button> }, './visual': { TimeDisplay: () => null }, './i18n': { t: (key: string) => key },
  });
  return { design, DailySwitch };
}
afterEach(cleanup);
it('press feedback and cancellation never submit; a completed tap calls the existing handler once', () => {
  const { DailySwitch } = fixture(), onPress = vi.fn();
  render(<DailySwitch working={false} seconds={0} disabled={false} busy={false} onPress={onPress} />);
  const key = screen.getByRole('button', { name: 'clockIn' });
  fireEvent.mouseDown(key); expect(onPress).not.toHaveBeenCalled();
  fireEvent.mouseLeave(key); expect(onPress).not.toHaveBeenCalled();
  fireEvent.click(key); expect(onPress).toHaveBeenCalledOnce();
});
it('reduced motion retains the labelled clock action without delaying a tap', () => {
  const f = fixture(), onPress = vi.fn(); f.design.reduceMotion = true;
  render(<f.DailySwitch working={false} seconds={0} disabled={false} busy={false} onPress={onPress} />);
  const key = screen.getByRole('button', { name: 'clockIn' });
  expect(screen.getByText('clockIn')).toBeTruthy(); fireEvent.mouseDown(key);
  fireEvent.click(key); expect(onPress).toHaveBeenCalledOnce();
});
it('busy and disabled clock keys cannot start a second operation', () => {
  const { DailySwitch } = fixture(), onPress = vi.fn();
  const ui = render(<DailySwitch working={false} seconds={0} disabled={false} busy onPress={onPress} />);
  fireEvent.click(screen.getByRole('button')); expect(onPress).not.toHaveBeenCalled();
  ui.rerender(<DailySwitch working={false} seconds={0} disabled busy={false} onPress={onPress} />);
  fireEvent.click(screen.getByRole('button')); expect(onPress).not.toHaveBeenCalled();
});
