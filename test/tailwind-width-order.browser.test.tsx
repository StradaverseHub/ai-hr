/**
 * The bug class jsdom structurally cannot see: which Tailwind utility WINS (r93, first browser test).
 *
 * 4dbe04c6 was a field that rendered full-width when the source plainly said `w-28`. The cause was that
 * `inputCls` already contains `w-full`, and when two utilities set the same property the winner is decided
 * by the order they are EMITTED into the stylesheet — not by the order they appear in the class attribute.
 * Reading the source concluded the width was set. So did every unit test, because none of them applied CSS.
 *
 * `${inputCls} w-28` is still the live idiom across ~133 files (components/earned-accrual-card.tsx:158 is
 * one), so this is a regression test for a pattern in daily use, not a museum piece.
 *
 * Real Chromium, real compiled Tailwind, real getComputedStyle.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import { inputCls } from '../components/ui';
import '../app/globals.css';

const px = (el: Element) => Number.parseFloat(getComputedStyle(el).width);

describe('Tailwind width utilities in a real engine', () => {
  beforeAll(() => {
    // A width-constrained parent, so `w-full` and `w-28` resolve to visibly different numbers. Without
    // this the container could be ~112px wide by accident and the assertion would prove nothing.
    document.body.style.width = '800px';
  });

  it('compiles the real stylesheet (guards the harness itself, not the app)', () => {
    render(<input aria-label="plain" className="w-28" />);
    // w-28 is 7rem = 112px. If this is 0 or the browser default, Tailwind never reached the page and
    // every other assertion in this file would be vacuously true.
    expect(px(screen.getByLabelText('plain'))).toBeCloseTo(112, 0);
  });

  /**
   * LIVE DEFECT, MEASURED — this is `it.fails`, so the suite stays green while the bug stands and turns
   * RED the moment someone fixes it, which is the signal to delete this wrapper and keep the assertion.
   *
   * Measured in Chromium on 2026-08-01: `${inputCls} w-28` computes to the CONTAINER width, not 7rem.
   * `w-full` wins. r86 diagnosed this cause on 4dbe04c6 and the idiom is still live in ~133 files, so
   * every `${inputCls} w-<n>` in this codebase is silently a no-op on width.
   *
   * NOT fixed here. The fix is either ordering (tailwind-merge, already a dependency, resolves conflicts
   * by intent rather than emission order) or dropping w-full from inputCls — and both change the rendered
   * width of inputs across 133 files, which needs its own item rather than riding along with a test runner.
   */
  it.fails('SHOULD let a later width utility win over the w-full inside inputCls', () => {
    render(<input aria-label="narrow" className={`${inputCls} w-28`} />);
    expect(px(screen.getByLabelText('narrow'))).toBeCloseTo(112, 0);
  });

  it('confirms the defect precisely: the field takes its container width instead of 7rem', () => {
    render(<input aria-label="measured" className={`${inputCls} w-28`} />);
    const width = px(screen.getByLabelText('measured'));
    expect(width).toBeCloseTo(px(document.body), 0);
    expect(width).not.toBeCloseTo(112, 0);
  });

  it('still stretches when nothing overrides w-full', () => {
    render(<input aria-label="wide" className={inputCls} />);
    expect(px(screen.getByLabelText('wide'))).toBeCloseTo(800, 0);
  });
});
