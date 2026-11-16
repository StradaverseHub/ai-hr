"""The admin sidebar's groups and flyouts (Chris, 2026-10-28, canvas): below the Modules block, one rule and no label, then
Organisation (group), Ticketing (a plain item), Comms (group), Reports & audit (group), System (group).

  * the order for the super admin; every org / end section is in exactly one slot (ADMIN_MENU_TAIL) and no key is lost
  * each group's flyout lists exactly its pages, with a hint line (the section's tab labels, or the fixed hint)
  * a group left with ONE page this admin may open is that page's own plain link (falsified by switching a gate off);
    a group with none is absent
  * the page being current marks the group row and the flyout row active; the group row is a button with aria-expanded
    and aria-controls pointing at a hidden flyout
  * the CSS and script the flyout relies on (fixed, 288px, z-index below the list panel, Esc, one open at a time)
  * routes, access map and nav gate untouched
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

a = H.setup(fresh_db=True)
s = H.Suite("Admin sidebar: groups and flyouts")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SUPER, BGA, EMP = H.actors(a)
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def side_of(u, path):
    with a.app.test_request_context(path):
        return a.admin_shell(u, path)["side"]


def tail(side):
    return side[-1]["items"]


s.section("the registry: every org / end section sits in exactly one slot")
slots = [k for _slot, _lbl, keys in a.ADMIN_MENU_TAIL for k in keys]
want = [x["key"] for x in a.ADMIN_SECTIONS if x["group"] in ("org", "end")]
s.check("every section of group org / end is in a slot, once", sorted(slots) == sorted(want) and len(slots) == len(set(slots)),
        (sorted(set(want) ^ set(slots))))
s.check("the slots are Organisation, Ticketing, Comms, Reports & audit, System, in that order",
        [x[1] for x in a.ADMIN_MENU_TAIL] == ["Organisation", "Ticketing", "Comms", "Reports & audit", "System"])
s.check("no section's key or group value changed (ADMIN_PEOPLE still reads group 'org')",
        {x["key"] for x in a.ADMIN_SECTIONS if x["group"] == "org"} == {"people", "leaders", "org", "audit"})

s.section("the super admin's sidebar")
sd = side_of(SUPER, "/admin")
s.check("blocks: top, modules (labelled Modules), then ONE unlabelled block", [g["label"] for g in sd] == [None, "Modules", None])
items = tail(sd)
s.check("order: Organisation, Ticketing, Comms, Reports & audit, All settings (System has one page for a non-system super admin)",
        [i["label"] for i in items] == ["Organisation", "Ticketing", "Comms", "Reports & audit", "All settings"],
        [i["label"] for i in items])
grp = {i["key"]: i for i in items if i.get("kind") == "group"}
s.check("Organisation, Comms and Reports & audit are groups; Ticketing and All settings plain links",
        set(grp) == {"org", "comms", "reports"} and all(not i.get("kind") for i in items if i["label"] in ("Ticketing", "All settings")))
s.check("each flyout lists exactly its pages",
        [p["label"] for p in grp["org"]["pages"]] == ["People", "Leaders and admins", "Org structure"]
        and [p["label"] for p in grp["comms"]["pages"]] == ["Email", "Banner", "What's new"]   # What's new added 2026-11-03
        and [p["label"] for p in grp["reports"]["pages"]] == ["Reports", "Audit and usage", "AI+ feedback"])   # AI+ feedback added 2026-10-29
hints = {p["key"]: p["hint"] for g in grp.values() for p in g["pages"]}
s.check("hints: tab labels joined, or the fixed line for a one-tab page",
        hints["email"] == "Schedule, Emails and templates, Sent"
        and hints["audit"] == "Audit log, Usage, Data integrity, Ask OneHR, AI insights"   # AI insights added 2026-11-06
        and hints["notices"] == "The notice bar on every page" and hints["reports"] == "Every report in one place"
        and hints["org"] == "Business groups and units" and hints["people"] == "Users, New joiners, Import"
        and hints["feedback"] == "Faces and lines after each check-in \u00b7 where it's asked"
        and hints["leaders"] == "Leaders, Admins, Roles &amp; access".replace("&amp;", "&"), hints)

s.section("the rendered markup")
c = H.client_as(a, SUPER["id"])
pg = c.get("/admin/audit-log").get_data(as_text=True)
nav = re.search(r'<nav class="adm-side".*?</nav>', pg, re.S).group(0)
s.check("one rule between the modules and the groups, no label above the groups",
        nav.count('class="adm-side-rule"') == 1 and nav.count('class="adm-side-sec"') == 1)
s.check("a group row is a button with aria-expanded and aria-controls naming its hidden flyout",
        all(re.search(r'<button type="button" class="adm-side-grp[^"]*" id="adm-grp-%s"[^>]*aria-expanded="false" aria-controls="adm-fly-%s"' % (k, k), nav)
            and re.search(r'<div class="adm-fly" id="adm-fly-%s"[^>]*hidden>' % k, nav) for k in ("org", "comms", "reports")))
s.check("a plain item is still a link (Ticketing, All settings)",
        re.search(r'<a class="adm-side-item" href="/admin/tickets[^"]*">\s*<span class="adm-side-lbl">Ticketing</span>', nav)
        and re.search(r'<a class="adm-side-item" href="/admin/all-settings">\s*<span class="adm-side-lbl">All settings</span>', nav))
s.check("on Audit and usage the Reports & audit group and its Audit and usage flyout row are the active ones",
        re.findall(r'class="adm-side-grp is-active"[^>]*>\s*<span class="adm-side-lbl">([^<]+)', nav) == ["Reports &amp; audit"]
        and re.findall(r'class="adm-fly-row is-active"[^>]*>\s*<span class="adm-fly-t">\s*<span class="adm-fly-lbl">([^<]+)', nav) == ["Audit and usage"])
s.check("...and no other group row is active", nav.count("adm-side-grp is-active") == 1)
s.check("every flyout row links to a page that opens",
        all(c.get(h.replace("&amp;", "&")).status_code == 200 for h in set(re.findall(r'class="adm-fly-row[^"]*" href="([^"]+)"', nav))))
s.check("the chevron is inline SVG 14px", nav.count('class="adm-side-chev" width="14" height="14"') == 3)
em = c.get("/admin/email").get_data(as_text=True)
s.check("on Email the Comms row is active", re.findall(r'class="adm-side-grp is-active"[^>]*>\s*<span class="adm-side-lbl">([^<]+)', em) == ["Comms"])
tk = c.get("/admin/tickets").get_data(as_text=True)
s.check("on Tickets the plain Ticketing item is active and no group is", 'class="adm-side-item is-active" href="/admin/tickets' in tk
        and "adm-side-grp is-active" not in tk)

s.section("per admin: one allowed page is a plain link, none hides the group (falsified)")
orig = a._admin_nav_allowed
try:
    # only Email allowed in Comms (Banner refused): Comms becomes the link "Email"
    a._admin_nav_allowed = lambda p, u: p["ep"] not in ("admin_notices", "admin_whats_new") and orig(p, u)
    it = tail(side_of(SUPER, "/admin"))
    s.check("Comms with only Email left renders as a plain link labelled Email",
            "Email" in [i["label"] for i in it] and "Comms" not in [i["label"] for i in it]
            and next(i for i in it if i["label"] == "Email").get("kind") is None)
    # falsify: with Banner allowed again it is a group
    a._admin_nav_allowed = orig
    it = tail(side_of(SUPER, "/admin"))
    s.check("falsified: with both pages allowed it is the Comms group", "Comms" in [i["label"] for i in it]
            and "Email" not in [i["label"] for i in it])
    # none allowed in Comms
    a._admin_nav_allowed = lambda p, u: not p["ep"].startswith(("admin_notices", "admin_whats_new", "admin_email", "admin_reminders")) and orig(p, u)
    it = tail(side_of(SUPER, "/admin"))
    s.check("a group with no page is absent", not any(i["label"] in ("Comms", "Email", "Banner") for i in it),
            [i["label"] for i in it])
    # a system admin: System group with two pages
    a._admin_nav_allowed = orig
finally:
    a._admin_nav_allowed = orig
with a.app.app_context():
    db = a.get_db()
    sid = db.execute("INSERT INTO users(username, full_name, password_hash, role, is_system_admin) VALUES ('zz-side-sys','ZZ side','x','admin',1)").lastrowid
    db.commit()
with a.app.test_request_context("/admin"):
    u = a.get_db().execute("SELECT * FROM users WHERE id=?", (sid,)).fetchone()
    it = tail(a.admin_shell(u, "/admin")["side"])
sysg = next((i for i in it if i.get("key") == "system"), None)
s.check("a system admin's last item is the System group: All settings, AI+ Connect",
        sysg and sysg.get("kind") == "group" and [p["label"] for p in sysg["pages"]] == ["All settings", "AI+ Connect"], it[-1:])
sysc = H.client_as(a, sid)
sp = sysc.get("/admin/connect").get_data(as_text=True)
s.check("...on AI+ Connect the System group is active, its row keeps the red AI+",
        re.findall(r'class="adm-side-grp is-active"[^>]*>\s*<span class="adm-side-lbl">([^<]+)', sp) == ["System"]
        and 'class="adm-fly-lbl"><span class="adm-ai">AI+</span> Connect' in sp)
if BGA:
    bit = tail(side_of(BGA, "/admin"))
    s.check("a BG admin sees only groups/links that hold pages (no empty group, no System)",
            all((i.get("kind") != "group") or len(i["pages"]) >= 2 for i in bit) and not any(i.get("key") == "system" for i in bit),
            [i["label"] for i in bit])

s.section("CSS and script")
css = open(os.path.join(HERE, "static", "style.css")).read()
js = open(os.path.join(HERE, "static", "admin.js")).read()
m = re.search(r"\.adm-fly \{([^}]*)\}", css)
fly = m.group(1) if m else ""
s.check("the flyout is fixed, 288px, white, 12px radius, above the header (890) and below the list panel (901)",
        "position: fixed" in fly and "width: 288px" in fly and "border-radius: 12px" in fly and "z-index: 895" in fly
        and H.cv("box-shadow: 0 12px 32px rgba(31,35,48,.16)") in fly)
s.check("the group row is 36px and one line", ".adm-side-grp {" in css and "min-height: 36px" in css.split(".adm-side-grp {")[1].split("}")[0]
        and "white-space: nowrap" in css)
s.check("the script opens one at a time, closes on Esc (focus back), outside click, resize and the sidebar's scroll",
        all(k in js for k in ("e.key === 'Escape'", "close(true)", "if (openBtn === btn) close(false); else open(btn);",
                              "addEventListener('resize'", "side.addEventListener('scroll'", "close(false);")))
s.check("the scroll-into-view reveals a lit group row too", ".adm-side-grp.is-active" in js)
s.check("nothing in the access map or the routes changed for it", "admin_side_groups" not in a.ADMIN_ACCESS_MAP)

sys.exit(s.done())
