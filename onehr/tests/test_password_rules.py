"""Two password rules (Chris, 2026-10-31: "Last 5 + common list").

1. The last 5 passwords: every writer of users.password_hash first pushes the OLD hash into password_history through
   _pw_history_push (hashes only, the newest 4 kept, so the current password plus these 4 are the last 5). Reuse is
   refused ONLY where the person sets their own password (the Change password page / Profile panel, and the emailed
   link, which also refuses the current password); an admin path never reads the history, so it can't tell an admin that
   a password they typed was an old one.
2. No easily guessed password, in _password_problem (so admin-typed ones too): digits and symbols only, a common word
   (PASSWORD_COMMON) with digits or symbols around it or leet speak in it, one repeated character, a straight or keyboard
   run, a word of the person's own name. Ordinary passphrases pass.

Every guard is falsified: switched off, its checks fail. Synthetic (ZZPR-*) on the shared suite database.
"""
import ast
import html
import io
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402
from werkzeug.security import check_password_hash, generate_password_hash  # noqa: E402

a = H.setup()
s = H.Suite("Password rules -- the last 5 passwords, and no easily guessed password")
assert H.SCRATCH_MARKER in a.DB_PATH, "refusing to run: not the scratch copy"
SU, _BGA, _E = H.actors(a)

# the suite makes and checks many hashes: a cheap one (the real work is the rules, not pbkdf2's cost)
_REAL_GEN = a.generate_password_hash
a.generate_password_hash = lambda pw, method="pbkdf2:sha256": _REAL_GEN(pw, method="pbkdf2:sha256:1000")


def cheap(pw):
    return _REAL_GEN(pw, method="pbkdf2:sha256:1000")


NAME = "Ahmad bin Ali"
P0 = "start kettle river 10"
P = ["", "lantern orchard 21", "pebble harbour maple 32", "violet thimble basket 43", "copper window ferry 54",
     "silver meadow lantern 65", "amber pillow garden 76"]
TOO_EASY, REUSED = a.PW_TOO_EASY_MSG, a.PW_REUSED_MSG


def _cleanup():
    with a.app.app_context():
        d = a.get_db()
        ids = [r[0] for r in d.execute("SELECT id FROM users WHERE employee_id LIKE 'ZZPR-%'")]
        if ids:
            ph = ",".join("?" * len(ids))
            d.execute("DELETE FROM password_history WHERE user_id IN (%s)" % ph, ids)
            d.execute("DELETE FROM password_resets WHERE user_id IN (%s)" % ph, ids)
            d.execute("DELETE FROM activity_log WHERE user_id IN (%s) OR target_user_id IN (%s)" % (ph, ph), ids + ids)
            d.execute("DELETE FROM users WHERE id IN (%s)" % ph, ids)
        d.execute("DELETE FROM login_attempts WHERE username LIKE '%ZZPR-%'")
        d.commit()


with a.app.test_request_context("/"):
    db = a.get_db()
    _cleanup()
    base = dict(db.execute("SELECT * FROM users WHERE role!='admin' AND left_at IS NULL LIMIT 1").fetchone())
    cols = [c for c in base.keys() if c != "id"]
    BG = a.org_bgs(db)[0]

    def mk(eid, pw=P0, **over):
        v = dict(base, username=eid, employee_id=eid, full_name=NAME, email=None, manager_id=None, hod_id=None,
                 left_at=None, role="user", admin_bg=None, password_hash=cheap(pw), is_demo=0, is_system_admin=0,
                 pw_source=None, pw_set_at=None, business_group=base["business_group"])
        v.update(over)
        db.execute("INSERT INTO users(%s) VALUES (%s)" % (",".join(cols), ",".join("?" * len(cols))), [v[c] for c in cols])
        return db.execute("SELECT id FROM users WHERE employee_id=?", (eid,)).fetchone()[0]

    U = mk("ZZPR-CHG")        # changes their own password five times
    RS = mk("ZZPR-RESET")     # sets one through the emailed link
    AD = mk("ZZPR-ADMSET")    # an admin resets
    IMP = mk("ZZPR-IMPORT")   # the Set passwords import
    PR = mk("ZZPR-PRUNE")
    ACC = mk("ZZPR-ACCOUNT", role="admin", admin_bg=BG, full_name="ZZPR admin account")
    db.commit()


def run(sql, args=()):
    with a.app.app_context():
        d = a.get_db()
        d.execute(sql, args)
        d.commit()


def one(sql, args=()):
    return H.one(a, sql, args)


def row(uid):
    return H.rows(a, "SELECT * FROM users WHERE id=?", (uid,))[0]


def hist(uid):
    return [r[0] for r in H.rows(a, "SELECT pw_hash FROM password_history WHERE user_id=? ORDER BY set_at, rowid", (uid,))]


def change(uid, cur, new, confirm=None):
    """The one writer of someone's own new password, called as the page and the Profile's panel call it."""
    with a.app.test_request_context("/"):
        d = a.get_db()
        return a._password_change(d, d.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone(), cur, new,
                                  new if confirm is None else confirm)


def admin_set(uid, new, first_only=False):
    with a.app.test_request_context("/"):
        d = a.get_db()
        sup = d.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
        return a._admin_password_set(d, sup, uid, new, first_only=first_only)


def prob(pw, names=NAME, ids=("A0001", "a0001")):
    return a._password_problem(pw, *ids, names=names)


# =================================================================================================================
s.section("the common list: the set itself")
words = a.PASSWORD_COMMON
s.check("a curated set of at least 150 base words (%d)" % len(words), len(words) >= 150)
s.check("every entry is lowercase letters only (so a password's letters compare to it)",
        all(re.fullmatch(r"[a-z]+", w) for w in words), [w for w in words if not re.fullmatch(r"[a-z]+", w)][:5])
for grp, want in (("classic", "password qwerty letmein welcome admin iloveyou monkey dragon football sunshine princess abc"),
                  ("Malaysian", "malaysia sayang cintaku merdeka kualalumpur selangor johor penang"),
                  ("company and product", "chinhin onehr aiplus starken midah chbm chce fiamma signature")):
    miss = [w for w in want.split() if w not in words]
    s.check("it holds the %s words" % grp, not miss, miss)

# =================================================================================================================
s.section("the common list: what is refused")
REFUSED = ["Password123!", "ChinHin@2026", "P@ssw0rd", "Welcome1", "Sayang123", "Malaysia2026", "12345678", "!!!!!!!!",
           "aaaaaaaa", "abcdefgh", "87654321", "qwertyui", "asdfghjk", "Chin Hin 2026", "chin-hin#1", "P4ssw0rd!!",
           "passw0rd2026", "Admin@123", "@dmin1234", "iloveyou99", "ILOVEYOU!!", "onehr.2026", "AIPlus#2026", "Starken88",
           "Midah@123", "Qwerty123", "!welcome!", "$unshine99", "Dragon2026"]
for pw in REFUSED:
    s.check("refused: %r" % pw, prob(pw) == TOO_EASY, prob(pw))
s.check("the message tells them what to do instead", "three words" in TOO_EASY and "too easy to guess" in TOO_EASY)
for pw, why in (("13579246", "digits only, not a run (no letter at all)"), ("#$%^&*()", "symbols only"),
                ("kkkkkkkk", "one character repeated, not a common word"), ("bcdefghi", "a straight run up"),
                ("zyxwvuts", "a straight run down"), ("34567890", "a digit run"), ("poiuytre", "a keyboard row, backwards"),
                ("ertyuiop", "a keyboard row, from the middle"), ("qwertyuiop12", "a keyboard row with digits after it"),
                ("abcdefgh9!", "a straight run with digits and symbols after it")):
    s.check("refused (%s): %r" % (why, pw), prob(pw) == TOO_EASY, prob(pw))
s.check("still the length rule first", a._password_problem("abc12", "X") == "A password needs at least 8 characters.")
s.check("still the Employee ID rule", "Employee ID" in (a._password_problem("ZZX9", "ZZX9") or ""))

# =================================================================================================================
s.section("the common list: ordinary passphrases pass (30 and more)")
GOOD = ["blue kettle river 7", "MyCatLikesRain!", "kopi-o kosong 2x", "correct horse battery staple", "Tr0ub4dor&3x",
        "purple-Mango-42-lamp", "I walk 3 dogs every morning", "lantern orchard 91", "Hujan turun di KL malam ini",
        "seven green bottles", "Sunrise over Kinabalu", "teh tarik less sweet 3", "blueberry pancakes on sunday",
        "Rolling_Stone_Gathers_9", "tiger-lily banana bread", "orbit paper window 4", "MangoSticky RiceFriday",
        "gentle waves at dawn", "parking lot B level 3", "The ferry leaves at 6!", "cloud9 over penang hill",
        "bakul kecil 88 merah", "jam tangan emas", "windy night, lazy cat", "flying tortoise 2", "my sister's red bicycle",
        "three small stones 12", "crimson fox jumps 100", "drink more water daily", "我喜欢喝咖啡每天早上",
        "NasiKandar after Friday prayers", "umbrella-on-the-train-7"]
bad_good = [pw for pw in GOOD if prob(pw)]
s.check("%d ordinary passphrases all pass" % len(GOOD), len(GOOD) >= 30 and not bad_good, bad_good)
s.check("and they pass for a person with no name given too", not [pw for pw in GOOD if prob(pw, names=None)])

# =================================================================================================================
s.section("the name rule: a word of the person's own name, titles and particles aside")
s.check("Ahmad@7391 is refused for Ahmad bin Ali", prob("Ahmad@7391") == TOO_EASY)
s.check("...and not without the name (it is not a common word)", prob("Ahmad@7391", names=None) is None)
s.check("...a leet reading too: 4hmad#9999", prob("4hmad#9999") == TOO_EASY)
s.check("...their other word, Ali (3 letters): Ali#123456", prob("Ali#123456") == TOO_EASY)
s.check("...the name run together: AhmadAli99", prob("AhmadAli99") == TOO_EASY)
s.check("the particle bin is not a name word: Bin@123456 passes", prob("Bin@123456") is None)
for nm, ok_pw, bad_pw in (("Nur Aisyah binti Mohd Ali", "Nur#123456", "Aisyah#1234"),
                          ("Dato Seri Lim Wei Ming", "Dato@123456", "Lim@123456"),
                          ("Kumar a/l Raju", "Anak!123456", "Raju@123456"),
                          ("Muhammad Faiz bin Haji Ismail", "Muhammad@7391", "Faiz-12345"),
                          ("SITI NURHALIZA BTE DATUK DR TAHA", "Siti#123456", "Nurhaliza@1")):
    s.check("%s: a particle passes (%s), a name word is refused (%s)" % (nm, ok_pw, bad_pw),
            prob(ok_pw, names=nm) is None and prob(bad_pw, names=nm) == TOO_EASY, (prob(ok_pw, names=nm), prob(bad_pw, names=nm)))
s.check("a name word under 3 letters counts for nothing (Li Wu: LiLiLiLi... is a repeat, but Wu#12345 passes)",
        prob("Wu#12345", names="Li Wu") is None)
s.check("a phrase that merely contains a name word passes: 'ahmad likes red tea 3'", prob("ahmad likes red tea 3") is None)
with a.app.test_request_context("/"):
    d = a.get_db()
    sup = d.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
    # the writers pass the person's full_name
    ok_, msg = a._admin_password_set(d, sup, AD, "Ahmad@7391")
s.check("the admin writer passes the person's name too: Ahmad@7391 refused for them", (not ok_) and TOO_EASY in msg, msg)

# =================================================================================================================
s.section("the common list reaches the admin-typed passwords too")
before = row(AD)["password_hash"]
ok_, msg = admin_set(AD, "Password123!")
s.check("People's Reset: Password123! is refused with the message", not ok_ and TOO_EASY in msg, msg)
s.check("...and nothing was written", row(AD)["password_hash"] == before and not hist(AD))
ok_, msg = admin_set(AD, "12345678")
s.check("...12345678 is a password, not 4 digits, and is refused", (not ok_) and TOO_EASY in msg, msg)
with a.app.test_request_context("/"):
    d = a.get_db()
    sup = d.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
    ok_, msg = a._admin_account_password_set(d, sup, ACC, "Welcome2026!", "BG admin")
s.check("an admin ACCOUNT's password: Welcome2026! refused too", (not ok_) and TOO_EASY in msg, msg)
ok_, msg = admin_set(AD, "salmon curry on tuesday 6")
s.check("a passphrase is accepted by the admin writer", ok_, msg)

# =================================================================================================================
s.section("the common list: each guard falsified")
_keep = (a.PASSWORD_COMMON, a._pw_name_words, a._pw_simple_pattern, a._pw_cores)
try:
    a.PASSWORD_COMMON = frozenset()
    s.check("falsified: with the set empty 'Password123!' passes", prob("Password123!") is None)
    s.check("...and the other checks still catch a repeat", prob("kkkkkkkk") == TOO_EASY)
    a.PASSWORD_COMMON = _keep[0]
    a._pw_name_words = lambda names: set()
    s.check("falsified: with the name rule off 'Ahmad@7391' passes", prob("Ahmad@7391") is None)
    a._pw_name_words = _keep[1]
    a._pw_simple_pattern = lambda low, plain: False
    s.check("falsified: with the pattern rule off 'bcdefghi' and 'kkkkkkkk' pass",
            prob("bcdefghi") is None and prob("kkkkkkkk") is None)
    a._pw_simple_pattern = _keep[2]
    a._pw_cores = lambda pw: ("x", {"x"})
    s.check("falsified: with the cores off a digits-only password and 'P@ssw0rd' pass",
            prob("13579246") is None and prob("P@ssw0rd") is None)
finally:
    a.PASSWORD_COMMON, a._pw_name_words, a._pw_simple_pattern, a._pw_cores = _keep
s.check("the guards are back", prob("Password123!") == TOO_EASY and prob("Ahmad@7391") == TOO_EASY
        and prob("bcdefghi") == TOO_EASY and prob("13579246") == TOO_EASY)

# =================================================================================================================
s.section("history: the table, hashes only")
cols_ = {r[1] for r in H.rows(a, "PRAGMA table_info(password_history)")}
s.check("password_history(user_id, pw_hash, set_at) exists", {"user_id", "pw_hash", "set_at"} <= cols_, cols_)
s.check("...with an index on (user_id, set_at)", any(
    [c[2] for c in H.rows(a, "PRAGMA index_info(%s)" % ix[1])] == ["user_id", "set_at"]
    for ix in H.rows(a, "PRAGMA index_list(password_history)")))
s.check("PASSWORD_HISTORY is 5: the current password plus 4 kept", a.PASSWORD_HISTORY == 5)

s.section("history: change the password five times")
first_hash = row(U)["password_hash"]
errs = []
cur = P0
for n in (1, 2, 3, 4):
    errs.append(change(U, cur, P[n]))
    cur = P[n]
s.check("four changes in a row are all accepted", errs == [None] * 4, errs)
s.check("the history holds 4 hashes: the start and the three before the current one", len(hist(U)) == 4)
s.check("...the first is the password they started on", check_password_hash(hist(U)[0], P0))
s.check("...and none of the rows is a readable password", all(h.startswith("pbkdf2:") and not any(p in h for p in P[1:] + [P0])
                                                              for h in hist(U)))
e5 = change(U, cur, P0)
s.check("the 5th change can't go back to the original password (still one of the last 5)", e5 == REUSED, e5)
s.check("...the message, word for word", REUSED == "You've used that password recently. Choose one that isn't one of your last 5 passwords.")
s.check("...and nothing changed", check_password_hash(row(U)["password_hash"], cur) and len(hist(U)) == 4)
for n in (1, 2, 3):
    s.check("the 5th change can't use P%d (in the history) either" % n, change(U, cur, P[n]) == REUSED)
s.check("the current password is refused (it was always: it must differ)", change(U, cur, cur) is not None)
e5 = change(U, cur, P[5])
cur = P[5]
s.check("the 5th change to a new password is accepted", e5 is None, e5)
s.check("the history still holds 4: the original password has dropped off", len(hist(U)) == 4
        and not any(check_password_hash(h, P0) for h in hist(U)))
e6 = change(U, cur, P0)
s.check("the 6th change CAN go back to the original password", e6 is None, e6)
cur = P0
s.check("...and P2 is still in the last 5 (P1 has dropped off), so it is refused", change(U, cur, P[2]) == REUSED)
s.check("the history after: 4 rows, newest last", len(hist(U)) == 4 and check_password_hash(hist(U)[-1], P[5]))
s.check("each change is on the password trail as before",
        one("SELECT COUNT(*) FROM activity_log WHERE action='password_change' AND user_id=?", (U,)) == 6)

s.section("history: the page and the Profile panel answer in the same words")
c = H.client_as(a, U)
r = c.post("/account/password", data={"current": cur, "new": P[2], "confirm": P[2], "csrf_token": "tok"})
txt = html.unescape(r.get_data(as_text=True))
s.check("Change password page: the reused-password message is shown", REUSED in txt and r.status_code == 200)
panel = c.post("/settings", data={"action": "password", "current": cur, "new": P[2], "confirm": P[2], "csrf_token": "tok"})
s.check("Profile's password panel: the same message", panel.status_code == 200
        and REUSED in html.unescape(panel.get_data(as_text=True)))
r = c.post("/account/password", data={"current": cur, "new": "Password123!", "confirm": "Password123!", "csrf_token": "tok"})
s.check("...and a common password gets the other message on the page", TOO_EASY in html.unescape(r.get_data(as_text=True)))

s.section("history: the reuse check runs last (after the cheap checks)")
calls = []
_ru = a._pw_reused
a._pw_reused = lambda *x, **k: (calls.append(1), _ru(*x, **k))[1]
try:
    change(U, cur, "short")
    change(U, cur, "Password123!")
    change(U, cur, "fresh teapot window 1", "something else 2")
    change(U, "wrong current", "fresh teapot window 1")
    s.check("a short, a common, a mismatched and a wrong-current attempt never reach the hash checks", not calls, calls)
    change(U, cur, P[2])
    s.check("...a password that passes them all does", len(calls) == 1)
finally:
    a._pw_reused = _ru

s.section("history: the current password is refused on a reset link (that gap is new)")
with a.app.app_context():
    d = a.get_db()
    tok = a._issue_reset_link(d, RS).rsplit("/reset/", 1)[1]
cl = H.client_as(a, 0)   # nobody is signed in; the link is the proof


def reset(token, new, confirm=None):
    with cl.session_transaction() as ss_:
        ss_.pop("user_id", None)
        ss_["csrf_token"] = "tok"
    return cl.post("/reset/" + token, data={"new": new, "confirm": new if confirm is None else confirm, "csrf_token": "tok"})


h_before = row(RS)["password_hash"]
r = reset(tok, P0)
s.check("the link refuses the current password", REUSED in html.unescape(r.get_data(as_text=True)) and r.status_code == 200)
s.check("...and writes nothing", row(RS)["password_hash"] == h_before and not hist(RS))
r = reset(tok, "Password123!")
s.check("the link refuses a common password with the other message", TOO_EASY in html.unescape(r.get_data(as_text=True)))
r = reset(tok, "tidy shelf lemon 12", "tidy shelf lemon 13")
s.check("a mismatch is still the mismatch", "confirmation don't match" in html.unescape(r.get_data(as_text=True)))
r = reset(tok, "tidy shelf lemon 12")
s.check("a new passphrase is accepted (redirect to sign-in)", r.status_code == 302, r.status_code)
s.check("...the old hash went into the history", len(hist(RS)) == 1 and check_password_hash(hist(RS)[0], P0))
s.check("...and the link is spent", one("SELECT COUNT(*) FROM password_resets WHERE user_id=? AND used_at IS NULL", (RS,)) == 0)
# the history reaches the link too
with a.app.app_context():
    d = a.get_db()
    tok = a._issue_reset_link(d, RS).rsplit("/reset/", 1)[1]
r = reset(tok, P0)
s.check("a second link refuses the password they had before (in the history)", REUSED in html.unescape(r.get_data(as_text=True)))
s.check("...and again the current one", REUSED in html.unescape(reset(tok, "tidy shelf lemon 12").get_data(as_text=True)))

s.section("history: an admin reset never checks it, but records it")
_boom = a._pw_reused
a._pw_reused = lambda *x, **k: (_ for _ in ()).throw(AssertionError("an admin path read the history"))
try:
    cur_ad = "salmon curry on tuesday 6"          # set above by the admin writer
    ok1, msg1 = admin_set(AD, "mango lassi at noon 8")
    ok2, msg2 = admin_set(AD, cur_ad)               # a password they had before: allowed for an admin
    s.check("an admin sets a new password without the history being read", ok1, msg1)
    s.check("...and sets back one the person had before (no 'recently' in the answer)", ok2 and "recently" not in msg2, msg2)
    with a.app.test_request_context("/"):
        d = a.get_db()
        sup = d.execute("SELECT * FROM users WHERE id=?", (SU["id"],)).fetchone()
        ok5, msg5 = a._admin_account_password_set(d, sup, ACC, "slate harbour pear 14", "BG admin")
    s.check("the admin ACCOUNT writer reads no history either", ok5, msg5)
finally:
    a._pw_reused = _boom
s.check("the admin resets recorded the old hash each time: 6 resets left 4 rows, none the current password",
        len(hist(AD)) == 4 and not any(check_password_hash(h_, "slate harbour pear 14") for h_ in hist(AD)), len(hist(AD)))
s.check("the account writer recorded its old hash", len(hist(ACC)) == 1)
a._pw_reused = lambda *x, **k: (_ for _ in ()).throw(AssertionError("read"))
try:
    raised = 0
    try:
        change(U, cur, "orchard basket sixty 3")
    except AssertionError:
        raised += 1
    with a.app.app_context():
        d = a.get_db()
        tk = a._issue_reset_link(d, RS).rsplit("/reset/", 1)[1]
    a.app.config["PROPAGATE_EXCEPTIONS"] = True
    try:
        reset(tk, "pewter garden bridge 5")
    except AssertionError:
        raised += 1
    finally:
        a.app.config["PROPAGATE_EXCEPTIONS"] = None
finally:
    a._pw_reused = _boom
s.check("...both person-side writers call it (a stub that raises is reached twice)", raised == 2, raised)

s.section("history: an import records it")
import_pw = "harbour lantern grape 21"
body = ("Employee ID,Password\nZZPR-IMPORT,%s\n" % import_pw).encode()
old_hash = row(IMP)["password_hash"]
SUP = H.client_as(a, SU["id"])
H.import_steps(SUP, "/admin/import/passwords", {"file": (io.BytesIO(body), "pw.csv")})
s.check("the import set the file's password", check_password_hash(row(IMP)["password_hash"], import_pw))
s.check("...and pushed the old hash into the history", hist(IMP) == [old_hash], len(hist(IMP)))
a._pw_reused = lambda *x, **k: (_ for _ in ()).throw(AssertionError("the import read the history"))
try:
    body2 = ("Employee ID,Password\nZZPR-IMPORT,%s\n" % P0).encode()
    H.import_steps(SUP, "/admin/import/passwords", {"file": (io.BytesIO(body2), "pw.csv")})
finally:
    a._pw_reused = _boom
s.check("...an import may set an old password again: it never reads the history", check_password_hash(row(IMP)["password_hash"], P0)
        and len(hist(IMP)) == 2, len(hist(IMP)))

s.section("history: pruning keeps 4 rows")
with a.app.test_request_context("/"):
    d = a.get_db()
    for i in range(10):
        d.execute("INSERT INTO password_history(user_id, pw_hash, set_at) VALUES (?,?,datetime('now', ?))",
                  (PR, cheap("old pw %d" % i), "-%d minutes" % (100 - i)))
    d.commit()
    s.check("10 rows set up", len(hist(PR)) == 10)
    cur_hash = d.execute("SELECT password_hash FROM users WHERE id=?", (PR,)).fetchone()[0]
    a._pw_history_push(d, PR)
    d.commit()
h = hist(PR)
s.check("one push leaves exactly 4 rows", len(h) == 4, len(h))
s.check("...the newest: the pushed one, and the 3 before it (old pw 9, 8, 7)",
        h[-1] == cur_hash and [any(check_password_hash(x, "old pw %d" % i) for x in h) for i in (9, 8, 7, 6)] == [True, True, True, False])
with a.app.test_request_context("/"):
    d = a.get_db()
    a._pw_history_push(d, PR)
    d.commit()
s.check("pushing the same current hash twice adds no duplicate", len(hist(PR)) == 4 and hist(PR).count(cur_hash) == 1)
_k = a.PASSWORD_HISTORY
try:
    a.PASSWORD_HISTORY = 50
    with a.app.test_request_context("/"):
        d = a.get_db()
        for i in range(10):
            d.execute("INSERT INTO password_history(user_id, pw_hash, set_at) VALUES (?,?,datetime('now'))", (PR, cheap("more %d" % i)))
        a._pw_history_push(d, PR)
        d.commit()
    s.check("falsified: with the cap raised the table is NOT cut to 4", len(hist(PR)) > 4)
finally:
    a.PASSWORD_HISTORY = _k
with a.app.test_request_context("/"):
    d = a.get_db()
    a._pw_history_push(d, PR)
    d.commit()
s.check("...and with the cap back, the next push cuts it again", len(hist(PR)) == 4)

s.section("history: falsify the push, then the reuse check")
KNOWN = "kept old secret 9"
n0 = len(hist(PR))
_p = a._pw_history_push
a._pw_history_push = lambda *x, **k: None
try:
    run("UPDATE users SET pw_source='own' WHERE id=?", (PR,))
    e = change(PR, P0, "granite meadow bell 3")
    s.check("falsified: with the push off a change writes no history row", e is None and len(hist(PR)) == n0)
finally:
    a._pw_history_push = _p
_r = a._pw_reused
a._pw_reused = lambda *x, **k: False
try:
    run("UPDATE users SET password_hash=? WHERE id=?", (cheap(P0), PR))
    run("INSERT INTO password_history(user_id, pw_hash) VALUES (?,?)", (PR, cheap(KNOWN)))
    e = change(PR, P0, KNOWN)
    s.check("falsified: with the reuse check off a password in the history is accepted", e is None, e)
finally:
    a._pw_reused = _r
run("UPDATE users SET password_hash=? WHERE id=?", (cheap(P0), PR))
s.check("with it back, the same password in the history is refused", change(PR, P0, KNOWN) == REUSED)

# =================================================================================================================
s.section("lint: a writer of password_hash that skips the helper fails")
src = H.source(a)
WRITER = re.compile(r"UPDATE\s+users\s+SET\b[^;]*?\bpassword_hash\b", re.I | re.S)


def unpushed_writers(source):
    """The functions holding an UPDATE users SET ... password_hash with no _pw_history_push call before it."""
    tree = ast.parse(source)
    found, seen = [], 0
    for fn in ast.walk(tree):
        if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        pushes = [n.lineno for n in ast.walk(fn) if isinstance(n, ast.Call)
                  and getattr(n.func, "id", getattr(n.func, "attr", "")) == "_pw_history_push"]
        for n in ast.walk(fn):
            if isinstance(n, ast.Constant) and isinstance(n.value, str) and WRITER.search(n.value):
                seen += 1
                if not any(p <= n.lineno for p in pushes):
                    found.append(fn.name)
    return found, seen


found, seen = unpushed_writers(src)
s.check("the real app.py: every writer pushes first (%d writers checked, none missing)" % seen, seen >= 5 and not found, found)
want = {"_password_change", "reset_password", "_admin_password_set", "_admin_account_password_set", "_pimp_apply"}
names_seen = {fn.name for fn in ast.walk(ast.parse(src)) if isinstance(fn, ast.FunctionDef) and any(
    isinstance(n, ast.Constant) and isinstance(n.value, str) and WRITER.search(n.value) for n in ast.walk(fn))}
s.check("...and the five known writers are the ones it reaches", want <= names_seen, want - names_seen)
fake_raw = 'def new_writer(db, uid, h):\n    db.execute("UPDATE users SET password_hash=?, pw_set_at=datetime(\'now\') WHERE id=?", (h, uid))\n'
fake_ok = 'def new_writer(db, uid, h):\n    _pw_history_push(db, uid)\n    db.execute("UPDATE users SET pw_source=\'x\', password_hash=? WHERE id=?", (h, uid))\n'
fake_late = fake_ok.replace("    _pw_history_push(db, uid)\n", "") + "    _pw_history_push(db, uid)\n"
s.check("falsified: a new raw writer is caught", unpushed_writers(fake_raw)[0] == ["new_writer"])
s.check("...a writer that pushes first is not", unpushed_writers(fake_ok) == ([], 1))
s.check("...one that pushes only AFTER the write is caught", unpushed_writers(fake_late)[0] == ["new_writer"])
mut = src.replace("_pw_history_push(", "_pw_history_pushed(")
s.check("falsified: the real source with the calls removed has every writer flagged", set(unpushed_writers(mut)[0]) >= want)

# =================================================================================================================
s.section("where people read the rules")
HINT = "Employee ID, your name, a common word or one of your last 5 passwords."
for tpl in ("change_password.html", "reset_password.html", "settings.html"):
    t = open(os.path.join(H.REPO, "templates", tpl), encoding="utf-8").read()
    s.check("%s carries the rule" % tpl, HINT in t)
s.check("the old 'something only you know' hint is gone", all("only you know" not in open(os.path.join(H.REPO, "templates", t_),
        encoding="utf-8").read() for t_ in ("change_password.html", "settings.html")))
q, ans = a.HELP_QA["dash_password"]
s.check("Help's quick answer states it", "last 5 passwords" in ans and "common word" in ans and "8 characters" in ans, ans)
s.check("the KB row 'password-rules' is seeded", one("SELECT COUNT(*) FROM kb_entries WHERE slug='password-rules'") == 1)
kb = H.rows(a, "SELECT body FROM kb_entries WHERE slug='password-rules'")[0][0]
s.check("...and says the same rules", all(x in kb for x in ("8 characters", "last 5 passwords", "Employee ID", "common word")))

_cleanup()
sys.exit(s.done())
