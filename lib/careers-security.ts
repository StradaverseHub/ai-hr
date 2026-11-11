/**
 * Recruitment slice 8 — the public careers pages' one stylesheet and their response headers. next.config.ts applies the
 * same headers to /careers/* and every careers response sets them itself, so whichever layer answers, the policy holds.
 *
 * The pages are plain server-rendered HTML with no script at all. The Content-Security-Policy therefore allows nothing
 * but this exact inline stylesheet (by its SHA-256 hash), same-origin form posts and no framing; nothing is loaded from
 * any origin, ours included. No cookie is ever set (D-026) and the pages are not indexed until the owner decides (D-028).
 */
import { createHash } from 'node:crypto';
export { CAREERS_BODY_MAX_BYTES } from './careers-route';

/** The AI HR (Atelier) look from DESIGN.md: neutral surfaces, ink and muted ink, hairlines, the orange accent. */
export const CAREERS_CSS = [
  ':root{--ink:#1c1c1f;--muted:#66666e;--line:#e8e8eb;--line-strong:#dcdce0;--surface:#fff;--ground:#f8f8f9;--primary:#c2410c;--primary-hover:#a8380a;--wash:#fdf1ea;--bad:#b42318;color-scheme:light}',
  '*{box-sizing:border-box}',
  'body{margin:0;background:var(--ground);color:var(--ink);font:400 .9375rem/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC","Noto Sans Thai","Noto Sans Tamil",sans-serif}',
  'a{color:var(--primary);text-decoration:underline;text-underline-offset:2px}a:hover{color:var(--primary-hover)}',
  ':focus-visible{outline:2px solid var(--primary);outline-offset:2px}',
  '.top{background:var(--surface);border-bottom:1px solid var(--line)}',
  '.bar{max-width:52rem;margin:0 auto;padding:.75rem 1rem;display:flex;flex-wrap:wrap;gap:.5rem 1rem;align-items:center;justify-content:space-between}',
  '.brand{font-weight:600;font-size:1rem;color:var(--ink);text-decoration:none}',
  '.langs{display:flex;flex-wrap:wrap;gap:.25rem .75rem;margin:0;padding:0;list-style:none;font-size:.8125rem}',
  '.langs a{color:var(--muted);text-decoration:none}.langs a[aria-current]{color:var(--ink);font-weight:600}',
  'main{max-width:52rem;margin:0 auto;padding:1.75rem 1rem 2.5rem}',
  'h1{font-size:1.5rem;line-height:1.25;font-weight:600;margin:0 0 .5rem}',
  'h2{font-size:1.0625rem;font-weight:600;margin:0 0 .75rem}',
  '.lead{font-size:1.0625rem;color:var(--ink);margin:0 0 .75rem}',
  '.muted{color:var(--muted);font-size:.875rem}',
  '.text{white-space:pre-wrap;overflow-wrap:anywhere;margin:0}',
  '.card{background:var(--surface);border:1px solid var(--line);border-radius:.75rem;padding:1rem;margin:0 0 1rem}',
  '.filters{display:grid;gap:.75rem;grid-template-columns:1fr}',
  '@media (min-width:40rem){.filters{grid-template-columns:2fr 1fr 1fr auto;align-items:end}}',
  'label{display:block;font-size:.8125rem;font-weight:500;margin:0 0 .25rem}',
  'input[type=text],input[type=email],input[type=tel],input[type=search],input[type=url],select,textarea{width:100%;min-height:2.25rem;padding:.375rem .625rem;border:1px solid var(--line-strong);border-radius:.5rem;background:var(--surface);color:var(--ink);font:inherit}',
  'textarea{min-height:6rem;resize:vertical}',
  'input[type=file]{font:inherit;font-size:.875rem;max-width:100%}',
  'input:focus,select:focus,textarea:focus{border-color:var(--primary);outline:3px solid rgba(194,65,12,.18);outline-offset:0}',
  '.btn{display:inline-block;min-height:2.25rem;padding:.5rem 1rem;border:0;border-radius:.5rem;background:var(--primary);color:#fff;font:inherit;font-weight:500;cursor:pointer;text-decoration:none}',
  '.btn:hover{background:var(--primary-hover);color:#fff}',
  '.ghost{background:var(--surface);color:var(--ink);border:1px solid var(--line-strong)}.ghost:hover{background:#efeff1;color:var(--ink)}',
  '.jobs{list-style:none;margin:0;padding:0;display:grid;gap:.75rem}',
  '.job{background:var(--surface);border:1px solid var(--line);border-radius:.75rem;padding:.875rem 1rem}',
  '.job a{font-weight:600;font-size:1rem}',
  '.meta{display:flex;flex-wrap:wrap;gap:.25rem .875rem;margin:.375rem 0 0;padding:0;list-style:none;color:var(--muted);font-size:.8125rem}',
  '.count{margin:1rem 0 .75rem;color:var(--muted);font-size:.875rem}',
  '.pager{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;margin:1rem 0 0;font-size:.875rem;font-variant-numeric:tabular-nums}',
  '.crumbs{font-size:.8125rem;color:var(--muted);margin:0 0 1rem}.crumbs ol{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:.375rem}',
  '.crumbs li+li::before{content:"/";margin-right:.375rem;color:var(--line-strong)}',
  '.field{margin:0 0 1rem}',
  '.help{color:var(--muted);font-size:.8125rem;margin:.25rem 0 0}',
  '.error{color:var(--bad);font-size:.8125rem;margin:.25rem 0 0;font-weight:500}',
  '[aria-invalid=true]{border-color:var(--bad)}',
  '.alert{border:1px solid var(--bad);background:#fef3f2;color:var(--bad);border-radius:.5rem;padding:.625rem .875rem;margin:0 0 1rem;font-size:.875rem}',
  '.check{display:flex;gap:.5rem;align-items:flex-start;font-weight:400;font-size:.875rem}',
  '.check input{margin-top:.2rem}',
  'details{border:1px solid var(--line);border-radius:.5rem;padding:.5rem .75rem;margin:.5rem 0 0;background:var(--ground)}',
  'summary{cursor:pointer;font-size:.875rem;font-weight:500}',
  '.trap{position:absolute;left:-10000px;top:auto;width:1px;height:1px;overflow:hidden}',
  '.req{color:var(--bad)}',
  '.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}',
].join('\n');

export const CAREERS_STYLE_HASH = `sha256-${createHash('sha256').update(CAREERS_CSS, 'utf8').digest('base64')}`;

/** default-src 'none' covers scripts, images, fonts, frames and connections; only the one stylesheet is allowed. */
export const CAREERS_CSP = `default-src 'none'; style-src '${CAREERS_STYLE_HASH}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`;

export const CAREERS_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': CAREERS_CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex, nofollow',
  'cache-control': 'private, no-store',
  'x-frame-options': 'DENY',
};
