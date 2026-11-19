import {cleanup, render} from '@testing-library/react';
import {afterEach, expect, it} from 'vitest';
import {ChartCard} from '../components/charts/ChartCard';
import '../app/globals.css';

afterEach(cleanup);

it('keeps all three export controls inside a narrow analytics card with a long heading', () => {
  const view = render(
    <main style={{width: 260}}>
      <ChartCard title="Fictional employee distribution by department" svgId="chart"
        filenameBase="fictional" exportLabel="Export chart">
        <svg id="chart" width="100%" height="60" aria-label="Fictional chart" />
      </ChartCard>
    </main>,
  );
  const heading = view.getByRole('heading', {name: 'Fictional employee distribution by department'});
  const bounds = heading.parentElement!.getBoundingClientRect();
  const controls = view.getAllByRole('button');
  expect(controls.map(control => control.textContent?.trim())).toEqual(['↓ PNG', '↓ JPEG', '↓ PDF']);
  for (const control of controls) {
    const rect = control.getBoundingClientRect();
    expect(rect.top).toBeGreaterThanOrEqual(heading.getBoundingClientRect().bottom);
    expect(rect.left).toBeGreaterThanOrEqual(bounds.left);
    expect(rect.right).toBeLessThanOrEqual(bounds.right);
  }
});
