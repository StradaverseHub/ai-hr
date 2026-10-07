# Monolith product-screen generator: spec dict -> .dc.html artboard, plus canvas placement.
import json, math, html, re, pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
PROJ = ROOT / 'project'

# ---------------------------------------------------------------- IA (mirrors components/sidebar.tsx + packs)
NAV = [
  {'label': None, 'items': [
    ('/', 'Dashboard'), ('/me', 'My Profile'), ('/org', 'Org chart'), ('/leave', 'My Leave'),
    ('/attendance', 'My Attendance', [('/attendance/clock', 'Clock in/out'), ('/attendance', 'Records'), ('/attendance/requests', 'Attendance Request'), ('/attendance/plan-ot', 'Plan OT')]),
    ('/claims', 'Claims'), ('/feedback', 'Feedback'), ('/knowledge-base', 'Knowledge Base'), ('/mobile-preview', 'Mobile App Preview')]},
  {'label': 'Manage', 'items': [
    ('/personnel', 'Personnel'), ('/leave/tracker', 'Team Leave Tracker'), ('/approvals', 'Approval Items'), ('/performance', 'Performance'),
    ('/roster', 'Roster'), ('/attendance/import', 'Import')]},
  {'label': 'Admin', 'items': [
    ('/admin/organization', 'Organization'), ('/admin/personnel', 'Personnel (admin)'),
    ('/admin/settings', 'System Settings', [('/admin/settings/employee-id', 'Employee ID numbering'), ('/admin/settings/dashboard', 'Dashboard cards'), ('/admin/settings/system-labels', 'System Labels'), ('/admin/settings/movement', 'Movement Settings'), ('/admin/settings/hiring-defaults', 'Hiring Defaults'), ('/admin/system-explorer', 'Dependency explorer')]),
    ('/admin/leave', 'Leave config', [('/admin/leave/entitlements', 'Entitlements'), ('/admin/leave/adjustments', 'Leave Adjustments'), ('/admin/leave/generate', 'Generate Entitlement'), ('/admin/leave/approval', 'Approval Workflow'), ('/admin/leave/payroll', 'Payroll Related'), ('/admin/leave/replacement', 'Replacement Leave')]),
    ('/admin/attendance', 'Attendance', [('/admin/holidays', 'Holidays'), ('/admin/attendance', 'Shift settings'), ('/admin/attendance-policy', 'Attendance policy'), ('/admin/attendance-allowance', 'Attendance allowance'), ('/admin/locations', 'Clocking location'), ('/admin/toil', 'Time off in lieu')]),
    ('/admin/claims', 'Claims config'),
    ('/payroll', 'Payroll', [('/payroll', 'Payroll Process'), ('/payroll/transactions', 'Transactions'), ('/admin/loans', 'Loans'), ('/payroll/back-pay', 'Back Pay'), ('/payroll/transaction-view', 'Transaction View'), ('/payroll/individual-payslip', 'Individual Payslip'), ('/payroll/statutory-adjustment', 'Statutory Adjustment'), ('/payroll/reports', 'Reports'), ('/payroll/statutory-forms', 'Statutory Forms'), ('/payroll/setup', 'Settings')]),
    ('/admin/notice-board', 'Notice Board'), ('/analytics', 'Analytics'),
    ('/reports', 'Reports', [('/reports?cat=master', 'Master'), ('/reports?cat=attendance', 'Attendance'), ('/reports?cat=leave', 'Leave'), ('/reports?cat=payroll', 'Payroll'), ('/reports?cat=claim', 'Claim'), ('/reports?cat=performance', 'Performance')]),
    ('/admin/audit', 'Audit trail'), ('/admin/scheduled-actions', 'Scheduled actions'), ('/admin/privacy', 'Data Privacy'), ('/admin/ai', 'AI'), ('/admin/users', 'Security & permissions')]},
]

CSS = r"""
*{box-sizing:border-box}
body{margin:0;background:#F2F0EB;color:#111111;font-family:'Schibsted Grotesk',system-ui,sans-serif;-webkit-font-smoothing:antialiased}
a{color:#111111}a:hover{color:#C23A00}
:focus-visible{outline:2px solid #FF4D00;outline-offset:3px}
.mono{font-family:'DM Mono',ui-monospace,monospace;font-size:11px;letter-spacing:.12em;text-transform:uppercase}
.num{font-family:'DM Mono',ui-monospace,monospace;font-variant-numeric:tabular-nums}
.mid{color:#63625D}.or{color:#C23A00}
.rail{flex:0 0 232px;border-right:1px solid #D9D6CF;padding:22px 20px 24px 24px;display:flex;flex-direction:column;gap:22px;background:#F2F0EB}
.rail .brand{text-decoration:none;color:#111;font-weight:500;display:block}
.rail .g{display:flex;flex-direction:column;gap:2px}
.rail .gl{color:#63625D;padding:0 0 6px;border-bottom:1px solid #D9D6CF;margin-bottom:6px}
.rail a.it,.rail span.it{display:flex;align-items:center;justify-content:space-between;min-height:32px;padding:0 0 0 10px;border-left:1px solid transparent;text-decoration:none;color:#63625D;font:400 11px 'DM Mono',monospace;letter-spacing:.12em;text-transform:uppercase}
.rail a.it:hover{color:#111;border-left-color:#D9D6CF}
.rail .it.on{color:#111;border-left-color:#111}
.rail .it.mod{color:#111}
.rail .kids{display:flex;flex-direction:column;margin:2px 0 6px 10px;border-left:1px solid #D9D6CF}
.rail .kids .it{min-height:28px;font-size:10px;padding-left:12px;border-left:0;margin-left:-1px}
.rail .kids .it.on{color:#C23A00;border-left:0}
.rail .cnt{color:#C23A00;font-size:10px}
.main{flex:1 1 0;min-width:0;padding:22px 48px 40px 44px;display:flex;flex-direction:column;gap:24px;position:relative}
.grid{position:absolute;inset:0;pointer-events:none;z-index:0;background:repeating-linear-gradient(90deg,rgba(17,17,17,.05) 0 1px,transparent 1px 8.3333%);margin:0 48px 0 44px}
.top{display:flex;align-items:center;gap:22px;flex-wrap:wrap;min-height:36px}
.navl{text-decoration:none;color:#63625D;padding:6px 0;border:0;border-bottom:1px solid transparent;background:transparent;cursor:pointer;font:inherit;letter-spacing:inherit;text-transform:inherit}
.navl:hover{color:#111}.navl.on{color:#111;border-bottom-color:#111}
.pill{display:inline-flex;align-items:center;justify-content:center;gap:10px;min-height:44px;padding:0 20px;border-radius:999px;border:1px solid #111;background:#111;color:#F2F0EB;font:600 14px 'Schibsted Grotesk',system-ui,sans-serif;cursor:pointer;text-decoration:none;white-space:nowrap}
.pill.ghost{background:transparent;color:#111}
.txt{display:inline-flex;align-items:center;gap:8px;min-height:44px;padding:0 2px;border:0;background:transparent;color:#111;font:500 15px 'Schibsted Grotesk',system-ui,sans-serif;cursor:pointer;text-decoration:none;border-bottom:1px solid #111}
.txt:hover{color:#C23A00;border-bottom-color:#C23A00}
.intent{display:flex;align-items:center;gap:14px;height:60px;border-top:1px solid #111;border-bottom:1px solid #111;padding:0 2px}
.intent input{flex:1;min-width:0;background:transparent;border:0;color:#111;font:500 19px 'Schibsted Grotesk',system-ui,sans-serif;letter-spacing:-.01em}
.intent input::placeholder{color:#9A988F}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#FF4D00;box-shadow:0 0 0 3px rgba(255,77,0,.18);animation:beat 2.4s ease-in-out infinite}
@keyframes beat{50%{box-shadow:0 0 0 7px rgba(255,77,0,0)}}
h1{margin:6px 0 0;font-size:56px;font-weight:500;line-height:.96;letter-spacing:-.04em}
.cells{display:grid;gap:0}
.cell{display:flex;flex-direction:column;gap:6px;padding:16px 18px 18px 18px;border-left:1px solid #D9D6CF}
.cell:first-child{border-left:0;padding-left:0}
.cell b{font:500 36px 'DM Mono',monospace;letter-spacing:-.03em;line-height:1;font-variant-numeric:tabular-nums}
.cell b small{font-size:14px;letter-spacing:0;color:#63625D;margin-left:6px;font-weight:400}
.sec{border-top:1px solid #111;padding-top:12px;display:flex;flex-direction:column;gap:10px}
.sh{display:flex;align-items:baseline;justify-content:space-between;gap:16px;flex-wrap:wrap}
.tabs{display:flex;gap:20px}
.th{display:grid;gap:14px;align-items:center;min-height:30px;color:#63625D;padding:0 2px}
.tr{display:grid;gap:14px;align-items:center;min-height:50px;border-top:1px solid #D9D6CF;text-decoration:none;color:#111;position:relative;background:transparent;border-left:0;border-right:0;border-bottom:0;cursor:pointer;text-align:left;font-family:inherit;width:100%;padding:0 2px;font-size:14px}
.tr:hover{background:#ECE9E2}
.tr.on{background:#111;color:#F2F0EB}
.tr.on .mid{color:#B8B5AC}
.tr::before{content:"";position:absolute;left:-16px;top:0;bottom:0;width:3px;background:#FF4D00;opacity:0}
.tr:hover::before{opacity:1}
.tbl{padding-left:16px;margin-left:-16px;border-bottom:1px solid #D9D6CF}
.tr .st{font-family:'DM Mono',monospace;font-size:11px;letter-spacing:.12em;text-transform:uppercase}
.kv{display:grid;gap:12px 20px;font-size:14px}
.kv > div{display:flex;flex-direction:column;gap:4px;padding:10px 0;border-top:1px solid #D9D6CF}
.kv .v{font-weight:500;font-size:15px}
.kv .v.big{font:500 28px 'DM Mono',monospace;letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.fm{display:grid;gap:14px 24px}
.fd{display:flex;flex-direction:column;gap:6px}
.fd input,.fd select,.fd textarea{background:transparent;border:0;border-bottom:1px solid #111;padding:8px 0;font:500 15px 'Schibsted Grotesk',system-ui,sans-serif;color:#111;min-height:40px}
.fd textarea{min-height:80px;resize:none}
.sw{display:flex;align-items:center;justify-content:space-between;gap:14px;min-height:40px;border-top:1px solid #D9D6CF;font-size:14px;cursor:pointer}
.sw i{width:40px;height:22px;border:1px solid #111;border-radius:999px;position:relative;flex:none}
.sw i::after{content:"";position:absolute;left:3px;top:3px;width:14px;height:14px;border-radius:50%;background:#111}
.sw.off i::after{left:21px;background:transparent;border:1px solid #111;width:12px;height:12px}
.ls{display:grid;grid-template-columns:70px 1fr auto;gap:14px;align-items:center;min-height:46px;border-top:1px solid #D9D6CF;font-size:14px;padding:0 2px}
.steps{display:flex}
.step{display:flex;flex-direction:column;gap:6px;flex:1 1 0;min-width:0;padding-right:10px}
.step i{display:block;height:1px;background:#111;margin-top:6px}
.step.todo i{background:#D9D6CF}.step.cur .mono{color:#C23A00}.step.cur i{background:#FF4D00;box-shadow:0 0 8px rgba(255,77,0,.6)}
.ruler{position:relative;height:72px;border-top:1px solid #111;display:flex}
.tick{flex:1;position:relative;border:0;background:transparent;cursor:pointer;color:#63625D;font:400 11px 'DM Mono',monospace;letter-spacing:.12em;padding:12px 0 0;text-align:left;text-transform:uppercase;line-height:1.7}
.tick::before{content:"";position:absolute;left:0;top:0;width:1px;height:10px;background:#111}
.tick.past{color:#111}.tick.on{color:#C23A00}.tick.on::before{width:2px;height:24px;background:#FF4D00;box-shadow:0 0 10px rgba(255,77,0,.6)}
.bars{display:flex;align-items:flex-end;gap:10px;height:160px;border-bottom:1px solid #111;padding:0 2px}
.bar{flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:stretch;gap:6px;height:100%}
.bar i{display:block;background:#111;min-height:2px}
.bar.or i{background:#FF4D00;box-shadow:0 0 12px rgba(255,77,0,.5)}
.bar span{text-align:center}
.note{display:flex;flex-direction:column;gap:6px;max-width:560px}
.empty{min-height:120px;display:flex;flex-direction:column;align-items:flex-start;justify-content:center;gap:8px;border:1px dashed #9A988F;padding:20px 24px}
.panel{flex:1 1 300px;min-width:280px;display:flex;flex-direction:column;gap:14px;border-top:1px solid #111;padding-top:12px}
.stage{position:relative;perspective:1400px;perspective-origin:50% 40%;display:flex;align-items:center;justify-content:center;cursor:grab;touch-action:none;user-select:none;flex:none}
.stage.dragging,.stage.dragging *{cursor:grabbing}
.spot{position:absolute;left:50%;top:50%;border-radius:50%;background:radial-gradient(circle,#FBFAF7 0%,rgba(251,250,247,.7) 28%,transparent 62%);pointer-events:none}
.shadow{position:absolute;left:50%;bottom:8%;border-radius:50%;background:rgba(17,17,17,.36);filter:blur(18px);transform:skewX(-26deg);pointer-events:none}
.cam{position:relative;transform-style:preserve-3d;transition:transform .6s cubic-bezier(.2,.8,.2,1)}.cam.drag{transition:none}
.ob{position:relative;transform-style:preserve-3d}
.ob .f{position:absolute;inset:0;background:linear-gradient(160deg,#3a3a3a 0%,#121212 38%,#0a0a0a 55%,#232323 78%,#050505 100%);overflow:hidden}
.ob .f::after{content:"";position:absolute;inset:0;background:linear-gradient(115deg,transparent 30%,rgba(255,255,255,.2) 47%,transparent 60%);background-size:260% 100%;animation:sheen 7s ease-in-out infinite}
@keyframes sheen{0%{background-position:120% 0}60%,100%{background-position:-140% 0}}
.ob .mark{position:absolute;left:14%;right:14%;height:3px;background:#FF4D00;box-shadow:0 0 12px #FF4D00,0 0 36px rgba(255,77,0,.6)}
.ob .line{position:absolute;left:14%;right:14%;height:1px;background:rgba(255,255,255,.22)}
.ob.slab{width:150px;height:210px}
.ob.slab .f{border-radius:8px}
.ob.slab .b{position:absolute;inset:0;background:#000;transform:translateZ(-26px);border-radius:8px}
.ob.slab .r{position:absolute;left:100%;top:0;width:26px;height:100%;transform-origin:left;transform:rotateY(90deg);background:#000}
.ob.slab .t{position:absolute;left:0;top:0;width:100%;height:26px;transform-origin:top;transform:rotateX(-90deg);background:#3a3a3a}
.ob.plates{width:200px;height:130px;transform:rotateX(58deg) rotateZ(-30deg)}
.ob.plates .f{border-radius:6px;box-shadow:0 8px 0 #000}
.ob.orb{width:180px;height:180px;border-radius:50%;background:radial-gradient(circle at 34% 28%,#5a5a5a,#111 42%,#000 100%);box-shadow:inset -24px -30px 50px rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;color:#F2F0EB;font:500 44px 'Schibsted Grotesk',sans-serif;letter-spacing:-.04em}
.ob.coin{width:180px;height:180px;border-radius:50%;background:radial-gradient(circle at 34% 28%,#3a3a3a,#111 40%,#000 100%);box-shadow:inset -20px -26px 50px rgba(0,0,0,.6)}
.ob.coin::after{content:"";position:absolute;inset:14%;border-radius:50%;border:1px solid rgba(255,255,255,.22)}
.ob.coin .mark{left:50%;top:50%;width:3px;height:40%;margin:-40% 0 0 -1px;transform-origin:bottom;right:auto}
.ob.cube{width:150px;height:150px}
.ob.cube .f{border-radius:6px}
.ob.cube .b{position:absolute;inset:0;background:#000;transform:translateZ(-150px)}
.ob.cube .r{position:absolute;left:100%;top:0;width:150px;height:100%;transform-origin:left;transform:rotateY(90deg);background:linear-gradient(180deg,#1b1b1b,#000)}
.ob.cube .t{position:absolute;left:0;top:0;width:100%;height:150px;transform-origin:top;transform:rotateX(-90deg);background:linear-gradient(90deg,#4a4a4a,#2a2a2a)}
.ob.card{width:230px;height:150px}
.ob.card .f{border-radius:10px}
.rv{animation:up .8s cubic-bezier(.2,.8,.2,1) both}
@keyframes up{from{transform:translateY(14px);opacity:0}}
.stat{font:400 11px 'DM Mono',monospace;letter-spacing:.14em;text-transform:uppercase;color:#63625D;display:flex;gap:28px;flex-wrap:wrap;border-top:1px solid #111;padding-top:12px;margin-top:auto}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
.still *,.still *::before,.still *::after{animation:none!important;transition:none!important}
@media (max-width:900px){.rail{display:none}.main{padding:18px 16px 32px}.grid{margin:0 16px}h1{font-size:40px}}
"""

FONTS = '<link rel="preconnect" href="https://fonts.googleapis.com">\n<link href="https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">'

CAMERA_JS = r"""
  constructor(p) { super(p); this.camCfg = { a0: -22, b0: -8, aMin: null, aMax: null, bMin: -35, bMax: 25, zMin: 0.7, zMax: 1.4 }; }
  view() { const st = this.state || {}, c = this.camCfg; return { a: st.ca == null ? c.a0 : st.ca, b: st.cb == null ? c.b0 : st.cb, zoom: st.zoom == null ? 1 : st.zoom }; }
  orbit(g, dx, dy) { const c = this.camCfg; const cl = (v, lo, hi) => lo == null ? v : Math.max(lo, Math.min(hi, v)); return { ca: cl(g.a + dx * 0.35, c.aMin, c.aMax), cb: cl(g.b - dy * 0.15, c.bMin, c.bMax) }; }
  zoomBy(e) { const v = this.view(), c = this.camCfg; const d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY; this.setState({ zoom: Math.min(c.zMax, Math.max(c.zMin, +(v.zoom * Math.exp(-d * 0.0016)).toFixed(3))) }); }
  onDown(e) { if (e.button != null && e.button !== 0) return; const v = this.view(); this.moved = false; this.drag = { x: e.clientX, y: e.clientY, a: v.a, b: v.b, id: e.pointerId, el: e.currentTarget }; }
  onMove(e) { const g = this.drag; if (!g) return; const dx = e.clientX - g.x, dy = e.clientY - g.y; if (!this.moved) { if (Math.abs(dx) + Math.abs(dy) < 5) return; this.moved = true; try { g.el.setPointerCapture(g.id); } catch (err) {} } this.setState(Object.assign({ dragging: true }, this.orbit(g, dx, dy))); }
  onUp() { if (!this.drag) return; this.drag = null; setTimeout(() => { this.moved = false; }, 0); this.setState({ dragging: false }); }
  camera() {
    const st = this.state || {}, v = this.view();
    return { ry: v.a, rx: v.b, zoom: v.zoom, dragCls: st.dragging ? 'drag' : '', stageCls: st.dragging ? 'dragging' : '',
      stageRef: (el) => { if (!el || el.__wheelBound) return; el.__wheelBound = true; el.addEventListener('wheel', (e) => { e.preventDefault(); this.zoomBy(e); }, { passive: false }); },
      wheel: (e) => { if (e.currentTarget && e.currentTarget.__wheelBound) return; this.zoomBy(e); },
      down: (e) => this.onDown(e), move: (e) => this.onMove(e), up: () => this.onUp() };
  }
"""

def esc(s):
    return html.escape(str(s), quote=True)

# board registry: href -> file (filled by build_all before rendering)
LINKS = {}

def link_for(href):
    return LINKS.get(href)

def nav_html(active):
    out = []
    for g in NAV:
        out.append('<div class="g">')
        if g['label']:
            out.append('<span class="mono gl">%s</span>' % esc(g['label']))
        for it in g['items']:
            href, label = it[0], it[1]
            kids = it[2] if len(it) > 2 else None
            kid_hrefs = [k[0] for k in kids] if kids else []
            is_on = active == href or (kids and active in kid_hrefs) or (kids and active.startswith(href + '/') and href != '/')
            cls = 'it' + (' on' if (active == href and not kids) else '') + (' mod' if (kids and is_on) else '')
            target = link_for(href)
            tag = '<a class="%s" href="%s">%s</a>' % (cls, esc(target), esc(label)) if target else '<span class="%s">%s</span>' % (cls, esc(label))
            out.append(tag)
            if kids and is_on:
                out.append('<div class="kids">')
                for kh, kl in kids:
                    kt = link_for(kh)
                    kc = 'it' + (' on' if active == kh else '')
                    out.append('<a class="%s" href="%s">%s</a>' % (kc, esc(kt), esc(kl)) if kt else '<span class="%s">%s</span>' % (kc, esc(kl)))
                out.append('</div>')
        out.append('</div>')
    return '\n'.join(out)

def cols_css(n, widths=None):
    if widths: return widths
    return 'repeat(%d, minmax(0, 1fr))' % n

def render_table(sec, idx):
    cols = sec['cols']; widths = sec.get('widths')
    g = cols_css(len(cols), widths)
    h = ['<div class="th mono" style="grid-template-columns: %s">%s</div>' % (g, ''.join('<span>%s</span>' % esc(c) for c in cols))]
    h.append('<div class="tbl">')
    key = 'rows%d' % idx
    h.append('<sc-for list="{{%s}}" as="r" hint-placeholder-count="%d">' % (key, min(len(sec['rows']), 6)))
    h.append('<button class="tr {{r.cls}}" type="button" onClick="{{r.pick}}" style="grid-template-columns: %s">' % g)
    for ci, c in enumerate(cols):
        st = sec.get('status_col')
        if st is not None and ci == st:
            h.append('<span class="st" style="color: {{r.color}}">{{r.c%d}}</span>' % ci)
        elif ci == 0 and sec.get('mono0', True):
            h.append('<span class="mono mid">{{r.c%d}}</span>' % ci)
        elif ci == 1 and sec.get('bold1', True):
            h.append('<span style="font-weight: 500">{{r.c%d}}</span>' % ci)
        else:
            h.append('<span class="mid">{{r.c%d}}</span>' % ci)
    h.append('</button></sc-for></div>')
    return '\n'.join(h)

def render_section(sec, idx):
    k = sec['kind']
    head = ''
    if sec.get('label') or sec.get('tabs') or sec.get('right'):
        tabs = ''
        if sec.get('tabs'):
            tabs = '<div class="tabs mono"><sc-for list="{{tabs%d}}" as="t" hint-placeholder-count="3"><button class="navl {{t.cls}}" type="button" onClick="{{t.pick}}">{{t.name}}</button></sc-for></div>' % idx
        right = '<span class="mono mid">%s</span>' % esc(sec['right']) if sec.get('right') else ''
        head = '<div class="sh"><span class="mono mid">%s</span>%s%s</div>' % (esc(sec.get('label', '')), tabs, right)
    body = ''
    if k == 'table':
        body = render_table(sec, idx)
    elif k == 'kv':
        n = sec.get('cols', 3)
        body = '<div class="kv" style="grid-template-columns: repeat(%d, minmax(0, 1fr))">%s</div>' % (n, ''.join(
            '<div><span class="mono mid">%s</span><span class="v%s"%s>%s</span>%s</div>' % (esc(f['l']), ' big' if f.get('big') else '', ' style="color: %s"' % f['color'] if f.get('color') else '', esc(f['v']), '<span class="mid" style="font-size: 12px">%s</span>' % esc(f['s']) if f.get('s') else '') for f in sec['fields']))
    elif k == 'form':
        n = sec.get('cols', 2)
        items = []
        for f in sec['fields']:
            t = f.get('t', 'input')
            if t == 'switch':
                items.append('<label class="sw%s"><span>%s</span><input type="checkbox" style="position:absolute;opacity:0;width:1px;height:1px"%s><i></i></label>' % ('' if f.get('on', True) else ' off', esc(f['l']), ' checked' if f.get('on', True) else ''))
            elif t == 'textarea':
                items.append('<label class="fd"><span class="mono mid">%s</span><textarea placeholder="%s">%s</textarea></label>' % (esc(f['l']), esc(f.get('p', '')), esc(f.get('v', ''))))
            elif t == 'select':
                items.append('<label class="fd"><span class="mono mid">%s</span><select>%s</select></label>' % (esc(f['l']), ''.join('<option%s>%s</option>' % (' selected' if o == f.get('v') else '', esc(o)) for o in f.get('o', [f.get('v', '')]))))
            else:
                items.append('<label class="fd"><span class="mono mid">%s</span><input type="%s" value="%s" placeholder="%s"></label>' % (esc(f['l']), f.get('type', 'text'), esc(f.get('v', '')), esc(f.get('p', ''))))
        body = '<div class="fm" style="grid-template-columns: repeat(%d, minmax(0, 1fr))">%s</div>' % (n, ''.join(items))
    elif k == 'list':
        body = ''.join('<div class="ls"><span class="%s">%s</span><span>%s%s</span><span class="mono" style="color: %s">%s</span></div>' % (
            'num mid' if i.get('num') else 'mono mid', esc(i.get('a', '')), '<span style="font-weight: 500">%s</span>' % esc(i['t']), ' <span class="mid">· %s</span>' % esc(i['s']) if i.get('s') else '', i.get('color', '#63625D'), esc(i.get('r', ''))) for i in sec['items'])
        body = '<div style="border-bottom: 1px solid #D9D6CF">%s</div>' % body
    elif k == 'steps':
        body = '<div class="steps">%s</div>' % ''.join('<div class="step %s"><span class="mono">%s</span><span class="mid" style="font-size: 13px">%s</span><i></i></div>' % (s.get('state', ''), esc(s['t']), esc(s.get('s', ''))) for s in sec['steps'])
    elif k == 'ruler':
        on = sec.get('on')
        body = '<div class="ruler">%s</div>' % ''.join('<button class="tick %s" type="button"><b style="font-weight: 500; color: inherit">%s</b>%s</button>' % ('on' if t['l'] == on else t.get('cls', ''), esc(t['l']), '<br>' + esc(t['s']) if t.get('s') else '') for t in sec['ticks'])
    elif k == 'bars':
        mx = max(b['v'] for b in sec['bars']) or 1
        body = '<div class="bars">%s</div>' % ''.join('<div class="bar %s"><i style="height: %d%%"></i><span class="mono mid">%s</span></div>' % ('or' if b.get('or') else '', round(b['v'] / mx * 100), esc(b['l'])) for b in sec['bars'])
    elif k == 'note':
        body = '<div class="note"><span class="mono %s">%s</span><span style="font-size: 18px; font-weight: 500; letter-spacing: -.02em">%s</span>%s%s</div>' % ('or' if sec.get('or') else 'mid', esc(sec.get('k', '')), esc(sec['t']), '<span class="mid" style="font-size: 13px; line-height: 1.5">%s</span>' % esc(sec['s']) if sec.get('s') else '', '<a class="txt" href="%s" style="align-self: flex-start; font-size: 14px">%s</a>' % (esc(sec.get('href', '#')), esc(sec['a'])) if sec.get('a') else '')
    elif k == 'empty':
        body = '<div class="empty"><span class="mono mid">%s</span><span style="font-size: 18px; font-weight: 500; letter-spacing: -.02em">%s</span>%s</div>' % (esc(sec.get('k', 'Nothing yet')), esc(sec['t']), '<span class="mid" style="font-size: 13px">%s</span>' % esc(sec['s']) if sec.get('s') else '')
    elif k == 'text':
        body = '<div class="mid" style="font-size: 14px; line-height: 1.6; max-width: 640px">%s</div>' % esc(sec['t'])
    elif k == 'chips':
        body = '<div style="display: flex; gap: 10px; flex-wrap: wrap">%s</div>' % ''.join('<span class="mono" style="border: 1px solid %s; padding: 7px 10px; color: %s">%s</span>' % ('#111' if c.get('on') else '#9A988F', '#111' if c.get('on') else '#63625D', esc(c['t'])) for c in sec['chips'])
    elif k == 'calendar':
        # weeks x 7 hairline grid with marked days
        marks = sec.get('marks', {})
        cells = []
        for d in range(1, sec.get('days', 31) + 1):
            m = marks.get(d)
            style = 'background:#111;color:#F2F0EB' if m == 'on' else ('color:#C23A00' if m == 'or' else ('color:#9A988F' if m == 'off' else ''))
            cells.append('<div style="min-height: 46px; border-top: 1px solid #D9D6CF; border-left: 1px solid #D9D6CF; padding: 6px 8px; font-size: 13px; %s"><span class="num">%d</span>%s</div>' % (style, d, '<br><span class="mono" style="font-size: 9px">%s</span>' % esc(sec['labels'][d]) if sec.get('labels', {}).get(d) else ''))
        pad = sec.get('start', 0)
        cells = ['<div style="min-height: 46px; border-top: 1px solid #D9D6CF; border-left: 1px solid #D9D6CF"></div>'] * pad + cells
        body = '<div class="mono mid" style="display: grid; grid-template-columns: repeat(7, minmax(0, 1fr))">%s</div><div style="display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); border-right: 1px solid #D9D6CF; border-bottom: 1px solid #D9D6CF">%s</div>' % (''.join('<span style="padding: 0 8px 6px">%s</span>' % d for d in ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']), ''.join(cells))
    elif k == 'raw':
        body = sec['html']
    actions = ''
    if sec.get('actions'):
        actions = '<div style="display: flex; gap: 22px; align-items: center; flex-wrap: wrap; padding-top: 6px">%s</div>' % ''.join(render_action(a) for a in sec['actions'])
    return '<section class="sec rv" style="animation-delay: %.1fs">%s%s%s</section>' % (0.15 + idx * 0.05, head, body, actions)

def render_action(a):
    kind = a.get('kind', 'txt')
    href = a.get('href')
    onclick = ' onClick="{{%s}}"' % a['fn'] if a.get('fn') else ''
    size = ' style="min-height: 40px; font-size: 14px"' if kind != 'pill' else ''
    if href:
        return '<a class="%s" href="%s"%s>%s</a>' % (kind, esc(href), size, esc(a['t']))
    return '<button class="%s" type="button"%s%s>%s</button>' % (kind, onclick, size, esc(a['t']))

def render_object(kind, extra=''):
    inner = {
        'slab': '<span class="b"></span><span class="r"></span><span class="t"></span><span class="f"><span class="line" style="top: 26%"></span><span class="line" style="top: 42%"></span><span class="mark" style="top: 58%"></span><span class="line" style="top: 74%"></span></span>',
        'plates': '<span class="f" style="transform: translateZ(0)"></span><span class="f" style="transform: translateZ(26px)"></span><span class="f" style="transform: translateZ(52px)"><span class="mark" style="top: 30%"></span></span>',
        'orb': esc(extra or 'AR'),
        'coin': '<span class="mark" style="transform: rotate(118deg)"></span>',
        'cube': '<span class="b"></span><span class="r"></span><span class="t"></span><span class="f"><span class="mark" style="top: 50%"></span></span>',
        'card': '<span class="f"><span class="line" style="top: 30%"></span><span class="mark" style="top: 50%; left: 14%; right: 50%"></span><span class="line" style="top: 72%"></span></span>',
    }[kind]
    w = {'slab': 300, 'plates': 320, 'orb': 300, 'coin': 300, 'cube': 300, 'card': 340}[kind]
    hgt = {'slab': 300, 'plates': 260, 'orb': 280, 'coin': 280, 'cube': 280, 'card': 240}[kind]
    return ('<div class="stage {{stageCls}}" aria-hidden="true" ref="{{stageRef}}" onPointerDown="{{down}}" onPointerMove="{{move}}" onPointerUp="{{up}}" onPointerCancel="{{up}}" onPointerLeave="{{up}}" onWheel="{{wheel}}" style="width: %dpx; height: %dpx">'
            '<span class="spot" style="width: %dpx; height: %dpx; margin: -%dpx"></span><span class="shadow" style="width: %dpx; height: %dpx; margin-left: -%dpx"></span>'
            '<div class="cam {{dragCls}}" style="transform: rotateX({{rx}}deg) rotateY({{ry}}deg) scale3d({{zoom}}, {{zoom}}, {{zoom}})"><div class="ob %s">%s</div></div></div>') % (
            w, hgt, w + 120, w + 120, (w + 120) // 2, int(w * .8), 40, int(w * .3), kind, inner)

def rail_html(spec, active):
    if spec.get('bare'): return ''
    return """  <nav class="rail" aria-label="Primary">
    <a href="%s" class="mono brand">AIHR <span class="mid">/ SYSTEM 01</span></a>
%s
    <span class="mono mid" style="margin-top: auto">AR · Aisyah Rahman<br>HR admin · EN</span>
  </nav>""" % (esc(link_for('/') or '#'), nav_html(active))

def build(spec):
    title = spec['title']
    active = spec.get('nav', spec.get('route', '/'))
    cells = ''
    if spec.get('cells'):
        cells = '<div class="cells rv" style="grid-template-columns: repeat(%d, minmax(0, 1fr)); animation-delay: .1s">%s</div>' % (len(spec['cells']), ''.join(
            '<div class="cell"><span class="mono %s">%s</span><b%s>%s%s</b>%s</div>' % ('or' if c.get('or') else 'mid', esc(c['l']), ' style="color: #C23A00"' if c.get('or') else '', esc(c['v']), '<small>%s</small>' % esc(c['u']) if c.get('u') else '', '<span class="mid" style="font-size: 13px">%s</span>' % esc(c['s']) if c.get('s') else '') for c in spec['cells']))
    header_actions = ''.join(render_action(a) for a in spec.get('actions', []))
    obj = render_object(spec['object'], spec.get('object_text', '')) if spec.get('object') else ''
    secs = '\n'.join(render_section(s, i) for i, s in enumerate(spec.get('sections', [])))
    panel = ''
    if spec.get('panel'):
        p = spec['panel']
        pk = ''.join('<div><span class="mono mid">%s</span><span class="v%s">%s</span></div>' % (esc(f['l']), ' big' if f.get('big') else '', esc(f['v'])) for f in p.get('kv', []))
        pa = ''.join(render_action(a) for a in p.get('actions', []))
        panel = '<aside class="panel rv" style="animation-delay: .25s"><div><span class="mono mid">%s</span><div style="font-size: 28px; font-weight: 500; letter-spacing: -.03em; line-height: 1.05; margin-top: 6px">%s</div>%s</div><div class="kv" style="grid-template-columns: repeat(2, minmax(0, 1fr))">%s</div>%s</aside>' % (
            esc(p.get('k', '')), esc(p['t']), '<div class="mid" style="font-size: 14px; margin-top: 6px; line-height: 1.5">%s</div>' % esc(p['s']) if p.get('s') else '', pk, '<div style="display: flex; gap: 20px; align-items: center; flex-wrap: wrap">%s</div>' % pa if pa else '')
    intent = ''
    if spec.get('intent') is not False:
        intent = '<label class="intent rv" style="animation-delay: .05s"><svg viewBox="0 0 24 24" width="20" height="20" fill="#FF4D00" aria-hidden="true"><path d="M12 2l2.2 6.8L21 11l-6.8 2.2L12 20l-2.2-6.8L3 11l6.8-2.2z"></path></svg><span style="position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0)">Ask or act</span><input type="text" placeholder="%s"><button class="txt" type="button" style="min-height: 40px; border-bottom: 0; font-size: 18px">↵</button></label>' % esc(spec.get('intent') or 'Ask anything, or say what to do')
    footer = ''.join('<span>%s</span>' % esc(f) for f in spec.get('footer', ['Sys OK']))
    main_cols = spec.get('panel') is not None
    body_inner = '<div style="flex: 999 1 560px; min-width: 0; display: flex; flex-direction: column; gap: 22px">%s</div>%s' % (secs, panel) if main_cols else secs
    html_doc = '''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>AIHR %s</title>
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
%s
<style>%s</style>
</helmet>
<div class="root {{motionClass}}" style="position: relative; min-height: %dpx; background: #F2F0EB; color: #111111; font-family: 'Schibsted Grotesk', system-ui, sans-serif; display: flex; align-items: stretch">
%s
  <div class="main"%s>
    <div class="grid" aria-hidden="true"></div>
    <div style="position: relative; z-index: 1; display: flex; flex-direction: column; gap: 24px; flex: 1">
      <div class="top mono rv">
        <span class="mid">%s</span>
        <span style="width: 1px; height: 14px; background: #D9D6CF"></span>
        <span class="mid">Nusantara Sdn Bhd <span style="color: #111">▾</span></span>
        <span class="mid" style="margin-left: auto; display: inline-flex; align-items: center; gap: 10px"><span class="dot" aria-hidden="true"></span>Live 09:12</span>
        <span class="mid">3 <span class="or">notices</span></span>
      </div>
      <section class="rv" style="display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; flex-wrap: wrap">
        <div style="flex: 1 1 420px; min-width: 0"><span class="mono mid">%s</span><h1>%s</h1>%s</div>
        %s
      </section>
      %s
      %s
      <div style="display: flex; gap: 32px; align-items: flex-start; flex-wrap: wrap">%s</div>
      <footer class="stat rv" style="animation-delay: .4s">%s</footer>
    </div>
  </div>
</div>
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{"motion":{"editor":"boolean","default":true,"section":"Look"},"$preview":{"width":1440,"height":%d}}'>
class Component extends DCLogic {%s
  renderVals() {
    const st = this.state || {};
    const data = %s;
    const out = { motionClass: this.props.motion === false ? 'still' : '' };
    Object.assign(out, this.camera());
    data.sections.forEach((s, i) => {
      if (s.tabs) {
        const cur = st['tab' + i] || s.tabs[0];
        out['tabs' + i] = s.tabs.map((t) => ({ name: t, cls: t === cur ? 'on' : '', pick: () => this.setState({ ['tab' + i]: t }) }));
        out['rows' + i] = (s.rows || []).filter((r) => cur === s.tabs[0] || r.tab === cur);
      } else if (s.rows) {
        out['rows' + i] = s.rows;
      }
      if (out['rows' + i]) {
        const sel = st['sel' + i];
        out['rows' + i] = out['rows' + i].map((r, k) => { const o = { cls: (sel == null ? r.on : sel === k) ? 'on' : '', color: r.color || '#111', pick: () => this.setState({ ['sel' + i]: k }) }; r.c.forEach((v, j) => { o['c' + j] = v; }); return o; });
      }
    });
    return out;
  }
}
</script>
</body>
</html>
''' % (esc(title), FONTS, CSS, spec.get('h', 1100), rail_html(spec, active), ' style="max-width: 720px; margin: 0 auto; padding-top: 120px"' if spec.get('bare') else '', esc(spec.get('route', '/')), esc(spec.get('kicker', '')), esc(spec['h1']),
       '<div style="display: flex; gap: 22px; align-items: center; flex-wrap: wrap; margin-top: 14px">%s</div>' % header_actions if header_actions else '',
       obj, intent, cells, body_inner, footer, spec.get('h', 1100), CAMERA_JS,
       json.dumps({'sections': [{'tabs': s.get('tabs'), 'rows': [{'c': r['c'], 'color': r.get('color'), 'tab': r.get('tab'), 'on': r.get('on', False)} for r in s['rows']] if s.get('rows') else None} for s in spec.get('sections', [])]}, ensure_ascii=False).replace('</', '<\\/'))
    return html_doc

def estimate_h(spec):
    h = 22 + 36 + 24 + 150 + 24
    if spec.get('object'): h = max(h, 22 + 36 + 24 + 320 + 24)
    if spec.get('intent') is not False: h += 60 + 24
    if spec.get('cells'): h += 120 + 24
    main = 0; side = 0
    for s in spec.get('sections', []):
        k = s['kind']; sh = 40
        if k == 'table': sh += 30 + 50 * len(s['rows'])
        elif k == 'kv': sh += 70 * math.ceil(len(s['fields']) / s.get('cols', 3))
        elif k == 'form': sh += 64 * math.ceil(len(s['fields']) / s.get('cols', 2)) + 10
        elif k == 'list': sh += 46 * len(s['items'])
        elif k == 'steps': sh += 60
        elif k == 'ruler': sh += 72
        elif k == 'bars': sh += 180
        elif k == 'note': sh += 110
        elif k == 'empty': sh += 130
        elif k == 'text': sh += 60
        elif k == 'chips': sh += 50
        elif k == 'calendar': sh += 46 * 6 + 30
        elif k == 'raw': sh += s.get('h', 200)
        if s.get('actions'): sh += 50
        main += sh + 22
    if spec.get('panel'):
        p = spec['panel']; side = 120 + 70 * math.ceil(len(p.get('kv', [])) / 2) + (60 if p.get('actions') else 0)
    h += max(main, side) + 60 + 40
    return int(math.ceil(h / 20.0) * 20)

def build_all(specs, canvas_path, y0, row_title_prefix='Product'):
    """specs: list of (group_title, [spec,...]). Writes files + merges canvas.json."""
    global LINKS
    LINKS = {}
    for _, group in specs:
        for sp in group:
            LINKS[sp['route']] = sp['file']
            for extra in sp.get('also', []): LINKS[extra] = sp['file']
    cv = json.loads(canvas_path.read_text())
    y = y0
    for gi, (gtitle, group) in enumerate(specs):
        note_id = 'p-%d' % gi
        cv['notes'][note_id] = {'kind': 'title1', 'maxW': 6000, 'text': gtitle, 'w': 240, 'x': 0, 'y': y}
        y += 280
        row_h = 0; x = 0; n = 0
        for sp in group:
            sp['h'] = sp.get('h') or estimate_h(sp)
            if not sp.get('custom'): (PROJ / sp['file']).write_text(build(sp))
            cv['boards'][sp['file']] = {'expand': 'fill', 'h': sp['h'], 'is_interactive': True, 'radius': 24, 'title': sp['title'] + ' · ' + sp['route'], 'w': 1440, 'x': x, 'y': y}
            if sp['file'] not in cv['order']: cv['order'].append(sp['file'])
            row_h = max(row_h, sp['h']); x += 1520; n += 1
            if n % 4 == 0:
                y += row_h + 120; row_h = 0; x = 0
        if n % 4 != 0: y += row_h + 120
        y += 120
    canvas_path.write_text(json.dumps(cv, indent=2, ensure_ascii=False) + '\n')
    return y
