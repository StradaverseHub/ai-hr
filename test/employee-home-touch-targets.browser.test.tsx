import { afterEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
vi.mock('@/app/scope-actions',()=>({setCompanyScope:async()=>{}}));
vi.mock('@/app/auth-actions',()=>({logoutAction:async()=>{}}));
vi.mock('@/app/ui-theme-actions',()=>({setUiTheme:async()=>({ok:true})}));
const { UserMenu } = await import('../components/user-menu');
import { CompanySwitcher } from '../components/company-switcher';
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
        render(<><header><NextIntlClientProvider locale="en" messages={en}><CompanySwitcher companies={[{id:'fictional-company',name:'Fictional company'}]} selected={['fictional-company']}/></NextIntlClientProvider></header><main>
          <Button className="min-h-11">Refresh</Button>
          <Button variant="outline" className="h-auto min-h-11 w-full whitespace-normal py-2" disabled>Submit claim</Button>
          <Button variant="outline" asChild className="h-auto min-h-11 w-full whitespace-normal py-2"><a href="/me">View calendar</a></Button>
        </main></>);
        const controls = [screen.getByRole('button', { name: 'All companies' }), screen.getByRole('button', { name: 'Refresh' }), screen.getByRole('button', { name: 'Submit claim' }), screen.getByRole('link', { name: 'View calendar' })];
        expect(controls).toHaveLength(4);
        for (const control of controls) {
          expect(control.getBoundingClientRect().height, control.textContent ?? '').toBeGreaterThanOrEqual(44);
          expect(parseFloat(getComputedStyle(control).minHeight)).toBeGreaterThanOrEqual(44);
        }
      });
    }
  }
}

// The previous height-only check missed the full header's two competing clusters.
// Exercise the real scope picker beside the production-sized account controls.
for (const width of [320, 390, 1280]) {
  it(`Atelier ${width}px keeps company scope reachable beside a long employee identity`, async () => {
    await page.viewport(width, 844);
    document.documentElement.setAttribute('data-ui-theme', 'atelier');
    render(<NextIntlClientProvider locale="en" messages={en}>
      <header data-app-header style={{width: '100%'}}>
        <div className="flex min-w-0 items-center gap-2.5"><span className="atelier-crumb">My HR</span><CompanySwitcher companies={[{id:'fictional-company',name:'Fictional company'}]} selected={['fictional-company']}/></div>
        <div className="atelier:hidden" />
        <div className="flex min-w-0 items-center justify-end gap-2">
          {['Notifications','Language','Theme'].map(name=><button key={name} aria-label={name} className="inline-flex size-9 min-h-11 max-sm:min-w-11 shrink-0">{name.slice(0,1)}</button>)}
          <UserMenu name="Amina Fictional" employeeCode="BOARD1-INDEPENDENT-AMINA-20261024" employed />
        </div>
      </header>
    </NextIntlClientProvider>);
    const scope=screen.getByRole('button',{name:'All companies'});
    const controls=[scope,...['Notifications','Language','Theme'].map(name=>screen.getByRole('button',{name})),screen.getByRole('button',{name:'Account menu'})];
    for(const control of controls){
      const r=control.getBoundingClientRect();
      expect(r.height).toBeGreaterThanOrEqual(44);
      if(width<640)expect(r.width).toBeGreaterThanOrEqual(44);
      expect(r.left).toBeGreaterThanOrEqual(0);expect(r.right).toBeLessThanOrEqual(width);
      const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
      expect(hit===control||control.contains(hit),control.getAttribute('aria-label')??control.textContent??'').toBe(true);
    }
    const a=scope.getBoundingClientRect(),b=screen.getByRole('button',{name:'Notifications'}).getBoundingClientRect();
    expect(a.right<=b.left||a.left>=b.right||a.bottom<=b.top||a.top>=b.bottom).toBe(true);
    await page.getByRole('button',{name:'All companies'}).click();
    expect(scope.getAttribute('aria-expanded')).toBe('true');
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  });
}
