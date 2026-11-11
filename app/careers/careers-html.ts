/**
 * Recruitment slice 8 — the public careers pages, rendered as plain HTML strings by the route handlers beside this file.
 *
 * Why route handlers and not App Router pages: these are the only Recruitment pages a visitor who is not signed in can
 * open. A route handler answers before the root layout, so the authenticated shell, its session gate, the locale cookie
 * and every client script are never involved; the response is a complete, script-free document whose only style is one
 * inline stylesheet allowed by hash (lib/careers-security.ts). A page would need nonces for Next's inline scripts.
 *
 * Every company- or job-supplied string — and every message, value and URL — passes through esc() exactly once on its
 * way into the markup. Forms work without JavaScript; "Copy link" is a read-only field holding the page address.
 */
import { NextResponse } from 'next/server';
import en from '../../messages/en.json';
import { defaultLocale, isLocale, localeNames, locales, type Locale } from '../../i18n/config';
import { HR_LOCAL_TZ } from '../../lib/hr-date';
import { careersJobPath, careersPagePath } from '../../lib/careers-route';
import { CAREERS_CSS, CAREERS_HEADERS } from '../../lib/careers-security';
import {
  CAREERS_MESSAGE_MAX, CAREERS_NAME_MAX, careersPageCount, type CareersFieldError, type CareersFormField, type CareersPublicJob, type CareersPublicPage,
} from '@/packs/recruitment/service';

type Dict = Record<string, unknown>;
export type CareersWords = typeof en.careersPublic;
type EmploymentTypes = Record<string, string>;
export type CareersView = { locale: Locale; explicit: boolean; words: CareersWords; employmentTypes: EmploymentTypes; origin: string };

/** HTML-escape text for element content and double-quoted attributes. */
export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
/** A message with {placeholders}: the message is escaped, then each value is escaped and put in. */
export function fill(template: string, values: Record<string, string | number> = {}): string {
  return esc(template).replace(/\{(\w+)\}/g, (whole, key: string) => (Object.hasOwn(values, key) ? esc(values[key]) : whole));
}

/**
 * The visitor's language: ?lang= when it names one of the six AI HR locales; otherwise the best Accept-Language match by
 * quality (a regional tag matches its language: ms-MY → ms, zh-Hans-CN → zh); otherwise English.
 */
export function chooseLocale(lang: string | null, acceptLanguage: string | null): { locale: Locale; explicit: boolean } {
  if (isLocale(lang)) return { locale: lang, explicit: true };
  const ranked = (acceptLanguage ?? '').split(',').slice(0, 20).map((part, i) => {
    const [tag, ...params] = part.trim().split(';');
    const q = params.map((p) => /^\s*q=([01](?:\.\d{0,3})?)\s*$/.exec(p)?.[1]).find((v) => v !== undefined);
    return { primary: tag.trim().toLowerCase().split('-')[0], q: q === undefined ? 1 : Number(q), i };
  }).filter((r) => r.q > 0).sort((a, b) => b.q - a.q || a.i - b.i);
  const hit = ranked.find((r) => isLocale(r.primary));
  return { locale: hit ? (hit.primary as Locale) : defaultLocale, explicit: false };
}

function merge(base: Dict, over: Dict): Dict {
  const out: Dict = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) {
    const b = out[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && b && typeof b === 'object') out[k] = merge(b as Dict, v as Dict);
    else if (typeof v === 'string' && v !== '') out[k] = v;
  }
  return out;
}

/** The careers words and employment type names in `locale`, any missing key falling back to English. */
export async function careersWords(locale: Locale): Promise<{ words: CareersWords; employmentTypes: EmploymentTypes }> {
  const base = { words: en.careersPublic as Dict, types: en.recruitment.job.employmentTypes as Dict };
  if (locale === 'en') return { words: base.words as CareersWords, employmentTypes: base.types as EmploymentTypes };
  const local = (await import(`../../messages/${locale}.json`)).default as { careersPublic?: Dict; recruitment?: { job?: { employmentTypes?: Dict } } };
  return {
    words: merge(base.words, local.careersPublic ?? {}) as CareersWords,
    employmentTypes: merge(base.types, local.recruitment?.job?.employmentTypes ?? {}) as EmploymentTypes,
  };
}

export async function careersView(request: Request, origin: string): Promise<CareersView> {
  const url = new URL(request.url);
  const { locale, explicit } = chooseLocale(url.searchParams.get('lang'), request.headers.get('accept-language'));
  const { words, employmentTypes } = await careersWords(locale);
  return { locale, explicit, words, employmentTypes, origin };
}

/** A same-site link that keeps an explicitly chosen language. */
export function link(view: Pick<CareersView, 'locale' | 'explicit'>, path: string, params: Record<string, string | number | null | undefined> = {}): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '') search.set(k, String(v));
  if (view.explicit) search.set('lang', view.locale);
  const q = search.toString();
  return q ? `${path}?${q}` : path;
}

const postedDate = (view: CareersView, iso: string) => new Intl.DateTimeFormat(view.locale, { dateStyle: 'medium', timeZone: HR_LOCAL_TZ }).format(new Date(iso));
const employment = (view: CareersView, type: string) => view.employmentTypes[type] ?? type;

/** The document: header (company name, language links), main content. No script, one stylesheet. */
function documentHtml(view: CareersView, o: { title: string; brand?: { name: string; href: string }; here: string; params?: Record<string, string | number | null>; body: string }): string {
  const langs = locales.map((l) => {
    const search = new URLSearchParams();
    for (const [k, v] of Object.entries(o.params ?? {})) if (v !== null && v !== undefined && v !== '') search.set(k, String(v));
    search.set('lang', l);
    return `<li><a href="${esc(`${o.here}?${search}`)}" hreflang="${l}" lang="${l}"${l === view.locale ? ' aria-current="true"' : ''}>${esc(localeNames[l])}</a></li>`;
  }).join('');
  return `<!doctype html><html lang="${esc(view.locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer"><title>${esc(o.title)}</title><style>${CAREERS_CSS}</style></head>`
    + `<body><header class="top"><div class="bar">${o.brand ? `<a class="brand" href="${esc(o.brand.href)}">${esc(o.brand.name)}</a>` : '<span></span>'}`
    + `<nav aria-label="${esc(view.words.language)}"><ul class="langs">${langs}</ul></nav></div></header><main>${o.body}</main></body></html>`;
}

export function careersResponse(status: number, html: string, extra: Record<string, string> = {}): NextResponse {
  return new NextResponse(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...CAREERS_HEADERS, ...extra } });
}

// ── Pages ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** The one Not found page for every address or job that is not public: no detail about why, and byte for byte the same
 *  whatever was asked for (its language links are relative to the requested path). */
export function notFoundHtml(view: CareersView): string {
  const w = view.words;
  return documentHtml(view, { title: w.notFoundTitle, here: '', body: `<h1>${esc(w.notFoundTitle)}</h1><p class="muted">${esc(w.notFoundBody)}</p>` });
}
/** 503: a read or submission that cannot be served now (database timeout, no verified request source for applications). */
export function unavailableHtml(view: CareersView, kind: 'read' | 'submit' = 'read'): string {
  const w = view.words;
  return documentHtml(view, { title: w.unavailableTitle, here: '', body: `<h1>${esc(w.unavailableTitle)}</h1><p class="muted">${esc(kind === 'submit' ? w.applicationsUnavailable : w.unavailableBody)}</p>` });
}
/** Turned away by per-process admission: a short "busy, try again" page. */
export function busyHtml(view: CareersView): string {
  const w = view.words;
  return documentHtml(view, { title: w.busyTitle, here: '', body: `<h1>${esc(w.busyTitle)}</h1><p class="muted">${esc(w.busyBody)}</p>` });
}
/** 429 before the body is read: this connection has already sent its hourly applications. */
export function submitLimitedHtml(view: CareersView): string {
  const w = view.words;
  return documentHtml(view, { title: w.limitedTitle, here: '', body: `<h1>${esc(w.limitedTitle)}</h1><p class="muted">${esc(w.tooMany)}</p>` });
}
/** 429: this connection read too many pages in a minute. */
export function readLimitedHtml(view: CareersView): string {
  const w = view.words;
  return documentHtml(view, { title: w.limitedTitle, here: '', body: `<h1>${esc(w.limitedTitle)}</h1><p class="muted">${esc(w.tooManyReads)}</p>` });
}

export type CareersFilters = { query: string; location: string; employmentType: string; page: number };

export function careersPageHtml(view: CareersView, address: string, page: CareersPublicPage, f: CareersFilters): string {
  const w = view.words;
  const here = careersPagePath(address);
  const pages = careersPageCount(page.total);
  const filterParams = { q: f.query || null, location: f.location || null, type: f.employmentType || null };
  const options = (values: string[], selected: string, label: (v: string) => string) =>
    values.map((v) => `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(label(v))}</option>`).join('');
  const jobs = page.jobs.map((j) => `<li class="job"><a href="${esc(link(view, careersJobPath(address, j.id)))}">${esc(j.title)}</a>`
    + `<ul class="meta"><li>${esc(w.jobNumber)}: ${esc(j.jobNumber)}</li><li>${esc(employment(view, j.employmentType))}</li><li>${esc(j.workLocation)}</li>`
    + `<li>${fill(w.postedOn, { date: postedDate(view, j.postedAt) })}</li></ul></li>`).join('');
  const filtered = !!(f.query || f.location || f.employmentType);
  const count = page.total === 0 ? (filtered ? w.resultsNone : w.noJobs) : page.total === 1 ? w.resultsOne : w.resultsMany;
  const pager = pages > 1 ? `<nav class="pager" aria-label="${esc(w.pagination)}">`
    + (page.page > 1 ? `<a class="btn ghost" href="${esc(link(view, here, { ...filterParams, page: page.page - 1 }))}">${esc(w.previous)}</a>` : '')
    + `<span>${fill(w.pageOf, { page: page.page, pages })}</span>`
    + (page.page < pages ? `<a class="btn ghost" href="${esc(link(view, here, { ...filterParams, page: page.page + 1 }))}">${esc(w.next)}</a>` : '')
    + '</nav>' : '';
  const body = `<h1>${esc(page.displayName)}</h1>`
    + (page.headline ? `<p class="lead">${esc(page.headline)}</p>` : '')
    + (page.introduction ? `<p class="text">${esc(page.introduction)}</p>` : '')
    + `<section aria-labelledby="jobs-title"><h2 id="jobs-title" class="sr">${esc(w.jobsTitle)}</h2>`
    + `<form class="card filters" method="get" action="${esc(here)}" role="search">`
    + (view.explicit ? `<input type="hidden" name="lang" value="${esc(view.locale)}">` : '')
    + `<div><label for="q">${esc(w.searchLabel)}</label><input type="search" id="q" name="q" maxlength="100" value="${esc(f.query)}"></div>`
    + `<div><label for="location">${esc(w.location)}</label><select id="location" name="location"><option value="">${esc(w.any)}</option>${options(page.locations, f.location, (v) => v)}</select></div>`
    + `<div><label for="type">${esc(w.employmentType)}</label><select id="type" name="type"><option value="">${esc(w.any)}</option>${options(page.employmentTypes, f.employmentType, (v) => employment(view, v))}</select></div>`
    + `<div><button class="btn" type="submit">${esc(w.search)}</button></div></form>`
    + `<p class="count" role="status">${fill(count, { count: page.total })}</p>`
    + (jobs ? `<ul class="jobs">${jobs}</ul>` : '') + pager + '</section>';
  return documentHtml(view, {
    title: page.displayName, brand: { name: page.displayName, href: link(view, here) }, here,
    params: { ...filterParams, page: page.page > 1 ? page.page : null }, body,
  });
}

export type CareersFormState = {
  values: { fullName: string; email: string; mobile: string; message: string; consent: boolean };
  errors: Partial<Record<CareersFormField, CareersFieldError>>;
};
export const emptyForm: CareersFormState = { values: { fullName: '', email: '', mobile: '', message: '', consent: false }, errors: {} };

function fieldError(view: CareersView, field: CareersFormField, error: CareersFieldError | undefined): string {
  if (!error) return '';
  const w = view.words.errors;
  const text = error === 'required' ? esc(w.required)
    : error === 'too_long' ? fill(w.tooLong, { max: field === 'message' ? CAREERS_MESSAGE_MAX : CAREERS_NAME_MAX })
      : error === 'file_type' ? esc(w.fileType)
        : error === 'file_too_large' ? esc(w.fileTooLarge)
          : error === 'file_name' ? esc(w.fileName)
            : error === 'notice_changed' ? esc(w.noticeChanged)
              : error === 'consent_required' ? esc(w.consentRequired)
            : field === 'email' ? esc(w.emailInvalid) : field === 'mobile' ? esc(w.mobileInvalid) : esc(w.invalid);
  return `<p class="error" id="${field}-error">${text}</p>`;
}

export function careersJobHtml(view: CareersView, address: string, data: CareersPublicJob, form: CareersFormState = emptyForm, accepting = true): string {
  const w = view.words;
  const pagePath = careersPagePath(address);
  const here = careersJobPath(address, data.job.id);
  const absolute = `${view.origin}${here}`;
  const e = form.errors;
  const invalid = (f: CareersFormField) => (e[f] ? ` aria-invalid="true" aria-describedby="${f}-error"` : '');
  const v = form.values;
  const field = (id: 'fullName' | 'email' | 'mobile', type: string, label: string, extra: string, required: boolean, help?: string) =>
    `<div class="field"><label for="${id}">${esc(label)}${required ? ' <span class="req" aria-hidden="true">*</span>' : ''}</label>`
    + `<input type="${type}" id="${id}" name="${id}" value="${esc(v[id])}"${required ? ' required' : ''}${extra}${invalid(id)}>`
    + (help ? `<p class="help">${esc(help)}</p>` : '') + fieldError(view, id, e[id]) + '</div>';
  const job = data.job;
  const body = `<nav class="crumbs" aria-label="${esc(w.breadcrumb)}"><ol><li><a href="${esc(link(view, pagePath))}">${esc(data.displayName)}</a></li>`
    + `<li aria-current="page">${esc(job.title)}</li></ol></nav>`
    + `<h1>${esc(job.title)}</h1><ul class="meta"><li>${esc(w.jobNumber)}: ${esc(job.jobNumber)}</li><li>${esc(employment(view, job.employmentType))}</li>`
    + `<li>${esc(job.workLocation)}</li><li>${fill(w.postedOn, { date: postedDate(view, job.postedAt) })}</li></ul>`
    + `<div class="field"><label for="share">${esc(w.copyLink)}</label><input type="url" id="share" readonly value="${esc(absolute)}" aria-describedby="share-help">`
    + `<p class="help" id="share-help">${esc(w.copyLinkHelp)}</p></div>`
    + (job.description ? `<section class="card" aria-labelledby="about"><h2 id="about">${esc(w.description)}</h2><p class="text">${esc(job.description)}</p></section>` : '')
    + `<section class="card" aria-labelledby="apply"><h2 id="apply">${esc(w.applyTitle)}</h2>`
    + (accepting ? applyForm() : `<p class="muted" role="status">${esc(w.applicationsUnavailable)}</p></section>`);
  return documentHtml(view, { title: `${job.title} · ${data.displayName}`, brand: { name: data.displayName, href: link(view, pagePath) }, here, body });

  function applyForm() {
    return (Object.keys(e).length ? `<p class="alert" role="alert">${esc(w.errors.summary)}</p>` : `<p class="muted">${esc(w.requiredNote)}</p>`)
    + `<form method="post" enctype="multipart/form-data" action="${esc(link(view, here))}" novalidate>`
    + `<input type="hidden" name="noticeVersion" value="${esc(data.notice.version)}">`
    + field('fullName', 'text', w.fullName, ` maxlength="${CAREERS_NAME_MAX}" autocomplete="name"`, true)
    + field('email', 'email', w.email, ' maxlength="254" autocomplete="email"', true)
    + field('mobile', 'tel', w.mobile, ' maxlength="40" autocomplete="tel"', false, w.mobileHelp)
    + `<div class="field"><label for="resume">${esc(w.resume)}</label><input type="file" id="resume" name="resume" accept=".pdf,.doc,.docx,.jpg,.jpeg,.png"${invalid('resume')}>`
    + `<p class="help">${esc(w.resumeHelp)}</p>${fieldError(view, 'resume', e.resume)}</div>`
    + `<div class="field"><label for="message">${esc(w.message)}</label><textarea id="message" name="message" maxlength="${CAREERS_MESSAGE_MAX}"${invalid('message')}>${esc(v.message)}</textarea>`
    + `<p class="help">${esc(w.messageHelp)}</p>${fieldError(view, 'message', e.message)}</div>`
    + `<div class="trap" aria-hidden="true"><label for="website">${esc(w.honeypot)}</label><input type="text" id="website" name="website" tabindex="-1" autocomplete="off"></div>`
    + `<div class="field"><label class="check"><input type="checkbox" name="consent" value="on"${v.consent ? ' checked' : ''} required${invalid('consent')}>`
    + `<span>${fill(w.consent, { company: data.displayName })} <span class="req" aria-hidden="true">*</span></span></label>`
    + `<details><summary>${fill(w.noticeTitle, { version: data.notice.version })}</summary><p class="text">${esc(data.notice.body)}</p></details>`
    + `${fieldError(view, 'consent', e.consent)}</div>`
    + `<button class="btn" type="submit">${esc(w.submit)}</button></form></section>`;
  }
}

export function careersThanksHtml(view: CareersView, address: string, data: CareersPublicJob): string {
  const w = view.words;
  const pagePath = careersPagePath(address);
  return documentHtml(view, {
    title: w.thanksTitle, brand: { name: data.displayName, href: link(view, pagePath) }, here: careersJobPath(address, data.job.id),
    body: `<h1>${esc(w.thanksTitle)}</h1><p>${fill(w.thanksBody, { job: data.job.title })}</p><p><a href="${esc(link(view, pagePath))}">${fill(w.backToCareers, { company: data.displayName })}</a></p>`,
  });
}

/** 429: too many from this connection, or the company's daily ceiling. */
export function careersLimitedHtml(view: CareersView, address: string, data: CareersPublicJob, kind: 'client' | 'company'): string {
  const w = view.words;
  const here = careersJobPath(address, data.job.id);
  return documentHtml(view, {
    title: w.limitedTitle, brand: { name: data.displayName, href: link(view, careersPagePath(address)) }, here,
    body: `<h1>${esc(w.limitedTitle)}</h1><p>${esc(kind === 'client' ? w.tooMany : w.companyLimit)}</p><p><a href="${esc(link(view, here))}">${esc(w.backToJob)}</a></p>`,
  });
}

/** 413: the form body is over the limit (refused before it is read). */
export function careersTooLargeHtml(view: CareersView, address: string, jobId: string): string {
  const w = view.words;
  const here = careersJobPath(address, jobId);
  return documentHtml(view, { title: w.tooLargeTitle, here, body: `<h1>${esc(w.tooLargeTitle)}</h1><p>${esc(w.tooLarge)}</p><p><a href="${esc(link(view, here))}">${esc(w.backToJob)}</a></p>` });
}
