'use client';

import { useId, useState, useTransition } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { firstDirtyGuard } from '@/lib/unsaved-changes';
import { useTranslations } from 'next-intl';
import { setUiTheme } from '@/app/ui-theme-actions';
import { DEFAULT_UI_THEME, UI_THEMES, UI_THEME_ATTRIBUTE, isUiTheme, type UiTheme } from '@/lib/ui-theme';

/** The theme <html> is currently painted in — the server wrote it from the `ui_theme` cookie. */
function currentTheme(): UiTheme {
  if (typeof document === 'undefined') return DEFAULT_UI_THEME;
  const v = document.documentElement.getAttribute(UI_THEME_ATTRIBUTE);
  return isUiTheme(v) ? v : DEFAULT_UI_THEME;
}

/**
 * r396 — the UI THEME picker (Monolith | Classic). Lives in the account menu, not as a header button:
 * the header's right cluster is a measured, full budget (test/topbar-overlap-guard.test.ts pins its child
 * list), and this is a once-in-a-while preference, not an everyday control. Light/dark stays on the
 * header's ThemeToggle — the two are independent axes.
 *
 * A real <select> with a visible <label>. On change it persists before repaint/navigation. Existing unsaved guards decide whether an
 * AI workspace navigation may proceed; Cancel keeps the form and current theme untouched.
 */
export function UiThemeSwitcher() {
  const t = useTranslations('components.uiTheme');
  const id = useId();
  const router=useRouter(),pathname=usePathname();
  const [error,setError]=useState('');
  const [theme, setTheme] = useState<UiTheme>(currentTheme);
  const [pending, startTransition] = useTransition();

  const onChange = (value: string) => {
    if (!isUiTheme(value)||value===theme||pending) return;
    const destination=value==='ai-responsive'?'/assistant':theme==='ai-responsive'&&pathname==='/assistant'?'/':null;
    const persist=()=>startTransition(async()=>{
      setError('');
      try{
        const result=await setUiTheme(value);if(!result.ok){setError(t('saveFailed'));return;}
        setTheme(value);document.documentElement.setAttribute(UI_THEME_ATTRIBUTE,value);
        if(destination&&pathname!==destination)router.push(destination);
      }catch{setError(t('saveFailed'));}
    });
    const guard=destination&&pathname!==destination?firstDirtyGuard():null;
    if(guard)guard.prompt(persist);else persist();
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-2 py-1.5">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {t('label')}
      </label>
      <select
        id={id}
        value={theme}
        disabled={pending}
        onChange={(e) => onChange(e.target.value)}
        className="h-11 min-w-0 rounded-md border border-input bg-background px-2 text-sm text-foreground"
      >
        {UI_THEMES.map((name) => (
          <option key={name} value={name}>
            {t(name)}
          </option>
        ))}
      </select>
      {error?<p role="alert" className="w-full text-sm text-destructive">{error}</p>:null}
    </div>
  );
}
