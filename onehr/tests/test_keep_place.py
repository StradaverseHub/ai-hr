"""Keep my place on tab / filter switches (Chris, 2026-11-09: "switching between the tab, the page will refresh and bring me up
to the top, it should stay at the same view, this should apply across all pages").

static/keep_place.js is loaded on every page; a same-page link, a GET form to the same page (a submit event, or form.submit(),
which the script wraps) and the JS reloads (colmenu, admin_talent_box, journey_chat's closed-stage switch) save the scroll before
they go, and the page restores it on the way in. The decision rules are plain functions, run here under node, each guard
falsified on its own. BU KPIs and Talent Box keep their own copies and carry the skip flag; pagination opens at the top.
"""
import json
import os
import re
import shutil
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup()
assert "onehr-tests" in a.DB_PATH, "refusing to run: not the scratch copy"
s = H.Suite("Keep my place: same-page tabs and filters land where you were")
SU, BGA, EMP = H.actors(a)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def rd(p):
    with open(os.path.join(ROOT, p), encoding="utf-8") as f:
        return f.read()


# ---------------------------------------------------------------- pages
s.section("the shared script is on every page; the two pages with their own copy skip it")
SU_C = H.client_as(a, SU["id"])
EMP_C = H.client_as(a, EMP["id"])
LOADED = re.compile(r'<script src="/static/keep_place\.js\?v=[^"]+"></script>')
pages = [("Home", SU_C, "/admin"), ("Home, a stage", SU_C, "/admin?stage=lm"), ("Leaders", SU_C, "/admin/leaders"),
         ("a user page", SU_C, "/admin/users/%d" % EMP["id"]), ("the journey page", EMP_C, "/review"),
         ("Users", SU_C, "/admin/users")]
for label, cl, url in pages:
    r = cl.get(url, follow_redirects=True)
    html = r.get_data(as_text=True)
    s.check("%s (%s) loads keep_place.js once" % (label, url), r.status_code == 200 and len(LOADED.findall(html)) == 1,
            (r.status_code, len(LOADED.findall(html))))
    s.check("%s is not marked as keeping its own place" % label, 'data-keep-place="own"' not in html)
r = SU_C.get("/admin/performance/bu-kpis", follow_redirects=True)
if r.status_code == 200:
    s.check("BU KPI setup renders the skip flag", 'data-keep-place="own"' in r.get_data(as_text=True))
for tpl in ("admin_bu_kpis", "talent_box"):
    src = rd("templates/%s.html" % tpl)
    s.check("%s sets the skip flag" % tpl, '{% block keep_place %} data-keep-place="own"{% endblock %}' in src)
base = rd("templates/base.html")
s.check("base.html has the skip block on <body>", '<body data-today="{{ odp_today }}"{% block keep_place %}{% endblock %}>' in base)
s.check("base.html loads the script unconditionally, versioned",
        re.search(r"^<script src=\"\{\{ url_for\('static', filename='keep_place\.js'\) \}\}\?v=\{\{ asset_v \}\}\"></script>$", base, re.M) is not None)
s.check("the two own copies are still there", "bk-scroll-keep" in rd("templates/admin_bu_kpis.html") and "tboxView" in rd("templates/talent_box.html"))

# ---------------------------------------------------------------- pagination
s.section("pagination opens at the top (data-scroll-top)")
PAGER = {"admin_assessors": 2, "admin_audit_log": 2, "admin_subjects": 2, "_gradeh_adm_people": 2, "_gradeh_adm_bands": 2,
         "admin_users": 2, "admin_users_bulk": 2, "admin_module_progress": 2}
for tpl, n in PAGER.items():
    src = rd("templates/%s.html" % tpl)
    tagged = re.findall(r'<a class="btn-link" data-scroll-top href="[^"]*"[^>]*>(?:&larr; Previous|Next &rarr;|&lsaquo; Previous|Next &rsaquo;)', src)
    s.check("%s: Previous and Next carry data-scroll-top" % tpl, len(tagged) == n, len(tagged))
    bare = re.findall(r'<a class="btn-link" href="[^"]*"[^>]*>(?:&larr; Previous|Next &rarr;|&lsaquo; Previous|Next &rsaquo;)', src)
    s.check("%s: no pager link without it" % tpl, not bare)
gc = rd("templates/gradeh_calib.html")
s.check("Grade H person pager (Previous / Next person) carries data-scroll-top",
        'data-scroll-top aria-label="Previous person"' in gc and 'data-scroll-top aria-label="Next person"' in gc)

# ---------------------------------------------------------------- JS reloads
s.section("the JS reloads save the place first")
cm = rd("static/colmenu.js")
s.check("colmenu: Apply and Clear call keepPlace before they navigate",
        len(re.findall(r"window\.keepPlace && window\.keepPlace\(\);\s*window\.location = buildUrl", cm)) == 2)
atb = rd("static/admin_talent_box.js")
s.check("admin_talent_box: the chip reload calls keepPlace before it navigates",
        re.search(r"mut\(u\.searchParams\);\s*window\.keepPlace && window\.keepPlace\(\);\s*window\.location\.href", atb) is not None)
jc = rd("static/journey_chat.js")
s.check("journey_chat: the closed-stage switch calls keepPlace before it navigates",
        re.search(r"dTo !== curStage\) \{ window\.keepPlace && window\.keepPlace\(\);\s*window\.location\.href = location\.pathname", jc) is not None)
kp = rd("static/keep_place.js")
s.check("keep_place.js wraps form.submit() (it fires no submit event)", "HTMLFormElement.prototype.submit" in kp)
s.check("every storage access is inside a try",
        all(re.search(r"try \{[^}]*$", kp[max(0, m.start() - 160):m.start()].split("\n\n")[-1]) or "try {" in kp[max(0, m.start() - 160):m.start()]
            for m in re.finditer(r"sessionStorage\.\w+Item", kp)))
s.check("the capture phase is used for click and submit",
        'root.addEventListener("click"' in kp and re.search(r"\}, true\);\s*\n\s*function formNote", kp) is not None
        and re.search(r'addEventListener\("submit".*?\}, true\);', kp, re.S) is not None)

# ---------------------------------------------------------------- the rules, under node, each guard falsified
s.section("the rules (node), every guard falsified")
if not shutil.which("node"):
    s.check("node is available", False, "node not found")
else:
    HARNESS = r"""
const K = require(%s);
const BASE = 'https://onehr.test/admin?stage=emp';
const link = (o) => K.linkSaves(Object.assign({button: 0, meta: false, ctrl: false, shift: false, alt: false,
  href: '/admin?stage=lm', base: BASE, target: null, download: false, listOpen: false, scrollTop: false, inNav: false}, o || {}));
const form = (o) => K.formSaves(Object.assign({method: 'get', action: '', base: BASE, target: null, scrollTop: false, inNav: false}, o || {}));
const NOW = 1000000;
const ent = (o) => Object.assign({path: '/admin', y: 640, at: NOW - 1000}, o || {});
const rest = (e, p, n, t) => K.restoreY(e, p === undefined ? '/admin' : p, n === undefined ? NOW : n, t === undefined ? 'navigate' : t);
const out = {
  link_base: link(), link_rel_query: link({href: '?stage=lm'}), link_abs_same: link({href: 'https://onehr.test/admin?x=1'}),
  link_other_path: link({href: '/admin/leaders'}), link_other_origin: link({href: 'https://evil.test/admin'}),
  link_hash_attr: link({href: '#top'}), link_hash_after: link({href: '/admin?stage=lm#t'}), link_null: link({href: null}),
  link_mailto: link({href: 'mailto:a@b.c'}), link_js: link({href: 'javascript:void(0)'}),
  link_right: link({button: 2}), link_middle: link({button: 1}), link_meta: link({meta: true}), link_ctrl: link({ctrl: true}),
  link_shift: link({shift: true}), link_alt: link({alt: true}), link_blank: link({target: '_blank'}), link_self: link({target: '_self'}),
  link_download: link({download: true}), link_list: link({listOpen: true}), link_top: link({scrollTop: true}), link_nav: link({inNav: true}),
  form_get: form(), form_nomethod: form({method: null}), form_GET: form({method: 'GET'}), form_post: form({method: 'post'}),
  form_dialog: form({method: 'dialog'}), form_samepath: form({action: '/admin?x=1'}), form_samepath_abs: form({action: 'https://onehr.test/admin'}),
  form_other: form({action: '/admin/users'}), form_origin: form({action: 'https://evil.test/admin'}), form_hash: form({action: '/admin#x'}),
  form_blank: form({target: '_blank'}), form_top: form({scrollTop: true}), form_nav: form({inNav: true}),
  k_cancel_then_post: (function () { const k = K.keeper(); k.link({button: 0, href: '?stage=lm', base: BASE}, {path: '/admin', y: 500, now: NOW});
    k.form({method: 'post', action: '', base: BASE}, {path: '/admin', y: 500, now: NOW + 1000}); return k.flush(NOW + 2000); })(),
  k_cancel_then_nav: (function () { const k = K.keeper(); k.link({button: 0, href: '?stage=lm', base: BASE}, {path: '/admin', y: 500, now: NOW});
    k.link({button: 0, href: '/admin?stage=hod', base: BASE, inNav: true}, {path: '/admin', y: 500, now: NOW + 1000}); return k.flush(NOW + 2000); })(),
  k_cancel_then_other: (function () { const k = K.keeper(); k.link({button: 0, href: '?stage=lm', base: BASE}, {path: '/admin', y: 500, now: NOW});
    k.link({button: 0, href: '/admin/leaders', base: BASE}, {path: '/admin', y: 500, now: NOW + 1000}); return k.flush(NOW + 2000); })(),
  k_link: (function () { const k = K.keeper(); k.link({button: 0, href: '?stage=lm', base: BASE}, {path: '/admin', y: 500, now: NOW}); return k.flush(NOW + 2000); })(),
  k_form: (function () { const k = K.keeper(); k.form({method: 'get', action: '', base: BASE}, {path: '/admin', y: 300, now: NOW}); return k.flush(NOW + 100); })(),
  k_keep: (function () { const k = K.keeper(); k.keep({path: '/admin', y: 77, now: NOW}); return k.flush(NOW + 100); })(),
  k_keep_then_post: (function () { const k = K.keeper(); k.keep({path: '/admin', y: 77, now: NOW}); k.form({method: 'post', action: '', base: BASE}, {path: '/admin', y: 77, now: NOW + 5}); return k.flush(NOW + 100); })(),
  k_old: (function () { const k = K.keeper(); k.link({button: 0, href: '?stage=lm', base: BASE}, {path: '/admin', y: 500, now: NOW}); return k.flush(NOW + 10001); })(),
  k_edge: (function () { const k = K.keeper(); k.link({button: 0, href: '?stage=lm', base: BASE}, {path: '/admin', y: 500, now: NOW}); return k.flush(NOW + 10000); })(),
  k_twice: (function () { const k = K.keeper(); k.keep({path: '/admin', y: 9, now: NOW}); k.flush(NOW); return k.flush(NOW); })(),
  k_nothing: K.keeper().flush(NOW),
  r_ok: rest(ent()), r_path: rest(ent({path: '/other'})), r_old: rest(ent({at: NOW - 30001})), r_edge: rest(ent({at: NOW - 30000})),
  r_future: rest(ent({at: NOW + 5000})), r_reload: rest(ent(), '/admin', NOW, 'reload'), r_back: rest(ent(), '/admin', NOW, 'back_forward'),
  r_prerender: rest(ent(), '/admin', NOW, 'prerender'), r_null: rest(null), r_str: rest('x'), r_y0: rest(ent({y: 0})), r_yneg: rest(ent({y: -5})),
  r_ystr: rest(ent({y: '640'})), r_ynan: rest(ent({y: NaN})), r_noat: rest({path: '/admin', y: 5}), r_ttl: K.TTL,
};
console.log(JSON.stringify(out));
""" % json.dumps(os.path.join(ROOT, "static", "keep_place.js"))
    p = subprocess.run(["node", "-e", HARNESS], capture_output=True, text=True, timeout=60)
    ok = p.returncode == 0 and p.stdout.strip()
    s.check("the rules load and run under node", bool(ok), p.stderr[-300:])
    if ok:
        R = json.loads(p.stdout)
        T = lambda k: R[k] is True            # noqa: E731
        F = lambda k: R[k] is False or R[k] is None  # noqa: E731
        s.check("a plain same-page link saves", T("link_base") and T("link_rel_query") and T("link_abs_same") and T("link_self"))
        s.check("another path, another origin, mailto and javascript: do not", F("link_other_path") and F("link_other_origin") and F("link_mailto") and F("link_js"))
        s.check("a #hash link does not (attribute or resolved)", F("link_hash_attr") and F("link_hash_after"))
        s.check("no href does not", F("link_null"))
        s.check("a right or middle click, or any modifier, does not", all(F(k) for k in ("link_right", "link_middle", "link_meta", "link_ctrl", "link_shift", "link_alt")))
        s.check("target other than _self does not", F("link_blank"))
        s.check("download does not", F("link_download"))
        s.check("data-list-open does not", F("link_list"))
        s.check("data-scroll-top does not", F("link_top"))
        s.check("a link inside a nav does not", F("link_nav"))
        s.check("a GET form to the same page saves (method missing, any case, relative or absolute action)",
                T("form_get") and T("form_nomethod") and T("form_GET") and T("form_samepath") and T("form_samepath_abs"))
        s.check("a POST or dialog form does not", F("form_post") and F("form_dialog"))
        s.check("a form to another path or origin does not", F("form_other") and F("form_origin"))
        s.check("a form with a #hash action, another target, data-scroll-top or inside a nav does not",
                F("form_hash") and F("form_blank") and F("form_top") and F("form_nav"))
        s.check("restore: same path, fresh, navigate gives the saved y", R["r_ok"] == 640 and R["r_edge"] == 640)
        s.check("restore: another path gives nothing", R["r_path"] is None)
        s.check("restore: older than 30 s gives nothing (and a clock gone backwards)", R["r_old"] is None and R["r_future"] is None and R["r_ttl"] == 30000)
        s.check("restore: reload, back / forward and other navigation types are left to the browser",
                R["r_reload"] is None and R["r_back"] is None and R["r_prerender"] is None)
        s.check("restore: no entry, a junk entry, y of 0, negative, text or NaN, no time gives nothing",
                all(R[k] is None for k in ("r_null", "r_str", "r_y0", "r_yneg", "r_ystr", "r_ynan", "r_noat")))
        s.check("pending: a click then nothing happens writes the entry only on pagehide (flush gives it once)",
                R["k_link"] == {"path": "/admin", "y": 500, "at": 1000000} and R["k_twice"] is None and R["k_nothing"] is None)
        s.check("pending: a GET form and keepPlace() set it", R["k_form"]["y"] == 300 and R["k_keep"]["y"] == 77)
        s.check("pending: a cancelled click, then a POST submit, leaves nothing (no stale restore)", R["k_cancel_then_post"] is None)
        s.check("pending: a click, then a nav-menu or other-page click, clears it", R["k_cancel_then_nav"] is None and R["k_cancel_then_other"] is None)
        s.check("pending: keepPlace() then a POST submit leaves nothing", R["k_keep_then_post"] is None)
        s.check("pending: older than 10 s is dropped, 10 s exactly is kept", R["k_old"] is None and R["k_edge"] is not None)
        # falsify: a copy of the script with one guard removed must change the answer the guard protects
        def mutant(old, new):
            m = kp
            for o_, n_ in (zip(old, new) if isinstance(old, tuple) else [(old, new)]):
                assert o_ in m, o_
                m = m.replace(o_, n_)
            tmp = os.path.join(os.environ.get("TMPDIR", "/tmp"), "kp_mutant_%d.js" % os.getpid())
            with open(tmp, "w") as f:
                f.write(m)
            h = HARNESS.replace(json.dumps(os.path.join(ROOT, "static", "keep_place.js")), json.dumps(tmp))
            q = subprocess.run(["node", "-e", h], capture_output=True, text=True, timeout=60)
            os.remove(tmp)
            return json.loads(q.stdout) if q.returncode == 0 else {}
        MUT = [
            ("same-path guard", "u.pathname === b.pathname && ", "", "link_other_path"),
            ("origin guard", "u.origin === b.origin && ", "", "link_other_origin"),
            ("hash guards (both layers)", ("&& !u.hash", 'String(o.href).indexOf("#") !== -1'), ("", "false"), "link_hash_after"),
            ("hash guards (both layers, attribute)", ("&& !u.hash", 'String(o.href).indexOf("#") !== -1'), ("", "false"), "link_hash_attr"),
            ("form hash guard", ("&& !u.hash", 'act.indexOf("#") !== -1'), ("", "false"), "form_hash"),
            ("button guard", "o.button !== 0 || ", "", "link_right"),
            ("meta guard", "o.meta || ", "", "link_meta"),
            ("target guard", 'if (o.target && o.target !== "_self") return false;\n    if (o.href', "if (o.href", "link_blank"),
            ("download guard", "|| o.download", "", "link_download"),
            ("list-open guard", "o.listOpen || ", "", "link_list"),
            ("scroll-top guard", "|| o.scrollTop || o.inNav || o.download", "|| o.inNav || o.download", "link_top"),
            ("nav guard", "|| o.inNav || o.download", "|| o.download", "link_nav"),
            ("form method guard", 'if (m !== "" && m !== "get") return false;', "", "form_post"),
            ("pending: link click clears", "pending = linkSaves(o) ? mk(ctx) : null;", "if (linkSaves(o)) pending = mk(ctx);", "k_cancel_then_nav"),
            ("pending: form submit clears", "pending = formSaves(o) ? mk(ctx) : null;", "if (formSaves(o)) pending = mk(ctx);", "k_cancel_then_post"),
            ("pending: 10 s limit", "&& now - e.at <= HOLD", "", "k_old"),
            ("pending: written once", "var e = pending; pending = null;", "var e = pending;", "k_twice"),
            ("restore path guard", "if (entry.path !== pathname) return null;", "", "r_path"),
            ("restore TTL guard", "if (!(age >= 0 && age <= TTL)) return null;", "", "r_old"),
            ("restore nav-type guard", 'if (nav !== "navigate") return null;', "", "r_reload"),
            ("restore y guard", "entry.y <= 0", "false", "r_y0"),
        ]
        for name, old, new, key in MUT:
            try:
                M = mutant(old, new)
            except AssertionError as e:
                s.check("falsify %s: the guard text is still in the script" % name, False, str(e))
                continue
            was, now = R[key], M.get(key, "no run")
            s.check("falsify %s: without it '%s' changes" % (name, key), now != was, (was, now))

sys.exit(s.done())
