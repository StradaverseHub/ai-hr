import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '../app/globals.css';
import '../app/atelier.css';
import { Button } from '../components/ui/button';

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-ui-theme');
  document.documentElement.classList.remove('dark');
  document.body.style.width = '';
});

for (const theme of ['classic', 'monolith', 'atelier']) {
  for (const dark of [false, true]) {
    for (const width of [390, 1280]) {
      it(`${theme} ${dark ? 'dark' : 'light'} ${width}px honors Home's explicit 44px button minimum`, () => {
        document.documentElement.setAttribute('data-ui-theme', theme);
        document.documentElement.classList.toggle('dark', dark);
        document.body.style.width = `${width}px`;
        render(<main>
          <Button className="min-h-11">Refresh</Button>
          <Button variant="outline" className="h-auto min-h-11 w-full whitespace-normal py-2" disabled>Submit claim</Button>
          <Button variant="outline" asChild className="h-auto min-h-11 w-full whitespace-normal py-2"><a href="/me">View calendar</a></Button>
        </main>);
        const controls = [screen.getByRole('button', { name: 'Refresh' }), screen.getByRole('button', { name: 'Submit claim' }), screen.getByRole('link', { name: 'View calendar' })];
        expect(controls).toHaveLength(3);
        for (const control of controls) {
          expect(control.getBoundingClientRect().height, control.textContent ?? '').toBeGreaterThanOrEqual(44);
          expect(parseFloat(getComputedStyle(control).minHeight)).toBeGreaterThanOrEqual(44);
        }
      });
    }
  }
}
