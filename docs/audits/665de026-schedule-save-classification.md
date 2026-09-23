# 665de026 · Attendance → Schedule — every form on the screen, before any of it moves

**Measured 2026-09-23 against `main` @ `a902a86b` (r331, after `07ebd04d` landed the Schedule Group's
working week in migration 0483).** Nothing here changes code. It is the deliverable the approved plan
owes the reporter *before* a single form is relocated, and it follows
`docs/audits/420ebab5-personnel-save-classification.md` and
`docs/audits/65b22c00-organization-save-classification.md` in both method and reason:

> a tab-wide **Save Changes** implies a tab-wide **Discard Changes**, and Discard is the dangerous
> half. A Discard that appeared to cover a recorded salary revision, a terminated CP38 deduction or an
> archived dependant would be a control lying about what it does.

On Schedule the equivalents are **deleting a Schedule Group**, **duplicating one**, **deactivating
one**, **revoking a clocking device** and — the one nobody would guess — **the deduction switch,
whose effective-from date the service stamps and an operator can never type**.

---

## 1. What is actually on the screen today

The route is `app/admin/attendance/schedule/` — three files, no sub-routes: `page.tsx` (737 lines),
`actions.ts`, `tabs.ts`. The page mounts six named tabs and renders **three** panels; the other three
render the shell's `notBuiltYet` label. Its cards live in four other files under
`app/admin/attendance-policy/`.

Counted by parsing each file with the TypeScript compiler's own comment ranges (leading, trailing and
JSX `{/* … */}` expressions) blanked out — not by grep:

| file | raw `<form` | comments stripped | server actions bound |
|---|---:|---:|---|
| `app/admin/attendance/schedule/page.tsx` | 2 | **2** | `saveScheduleGroupAttendanceAction`, `saveScheduleGroupOvertimeAction` |
| `app/admin/attendance-policy/schedule-group-card.tsx` | 4 | **3** | `copyAttendanceRuleAction`, `setAttendanceRuleStatusAction`, `deleteAttendanceRuleAction` |
| `app/admin/attendance-policy/company-policy-card.tsx` | 0 | **0** | — (links only) |
| `app/admin/attendance-policy/work-schedule-overtime-card.tsx` | 1 | **1** | `revokeDeviceAction` |
| `app/admin/attendance-policy/rules/rule-form.tsx` | 1 | **1** | `updateAttendanceRuleAction` **or** `createAttendanceRuleAction` (one tag, two actions) |
| `app/admin/attendance-policy/schedule/work-schedule-form.tsx` | 1 | **1** | `setAttendancePolicyAction` |
| **total** | **9** | **8** | **9 distinct actions** |

### The double-count trap is real, and it is in `schedule-group-card.tsx`

Both earlier audits record `<form …>` strings living inside explanatory prose, and the approved plan
repeats the warning. **Measured: it happens here exactly once.**
`app/admin/attendance-policy/schedule-group-card.tsx:26` says, in prose, *"the button stays inside the
same `<form>` and posts the same one field"* — so `grep -c '<form'` reports **4** against an actual
**3**. Every other file counts the same stripped or not. A raw grep over the six files gives **9**;
the honest figure is **8** tags binding **9** actions.

### Eight tags is not eight buttons

Three of the eight are rendered **once per Schedule Group row**, and one **once per registered
device**:

- `copyAttendanceRuleAction`, `setAttendanceRuleStatusAction` and `deleteAttendanceRuleAction` are
  inside the row loop. Delete is suppressed on the `is_default` "Standard" group (and the service
  refuses it anyway), so a tenant with *n* groups renders `3n − 1` row buttons.
- `revokeDeviceAction` is once per row of the registered-device table.
- `updateAttendanceRuleAction` / `createAttendanceRuleAction` and `setAttendancePolicyAction` are
  rendered **only while their panel is open** (`?editGroup=` / `?policy=`), so they are invisible on a
  first load and then appear beside four cards they have nothing to do with.

This is the reporter's complaint measured: on a three-group tenant the General tab alone carries eight
row buttons, a table of every shift in the tenant, one row per company, a device table and a
four-entry "not configured here" card — and the two forms that actually edit *a Schedule Group's*
settings are on two **other** tabs, behind a group picker that has to be set on each of them
separately.

---

## 2. The rule used to split (a) from (b)

Carried over unchanged from the personnel and organization audits, restated for a Schedule Group. A
form is **(b) RECORD LIFECYCLE** if any one of these is true:

1. it **creates** a row, or **destroys** one;
2. it changes a row's **existence-like state** (active / inactive, revoked) rather than a value on it;
3. it causes the **service to stamp a value the operator cannot type**, so re-applying the same form
   does not restore the state that was there before;
4. it **replaces a child collection wholesale** rather than overwriting a field.

Everything else is **(a) FIELD EDIT**: it overwrites a value on a record that already exists, and
posting the previous value back restores exactly the previous state.

---

## 3. The buckets

### (a) FIELD EDIT — safe under a shared Save, and genuinely per-Schedule-Group

| # | action | file | what it writes | scope |
|---|---|---|---|---|
| a1 | `saveScheduleGroupAttendanceAction` | `schedule/actions.ts` | six minute figures: both grace periods, both "after N" intervals, both "record M" figures | ONE Schedule Group |
| a2 | `saveScheduleGroupOvertimeAction` | `schedule/actions.ts` | `apply_to_early_ot` + each band's `rounding_mode` / `round_to_minutes` | ONE Schedule Group |

Both are already written defensively and **neither may be replaced by a wider form**: each re-reads
the stored rule, carries every column forward verbatim, and overlays only the fields its own section
renders. `applyDeductions` is taken from the stored row and never from `fd`. The overtime bands are
rebuilt from the stored rows and matched **by `fromMinutes`**, never by row id — `updateAttendanceRule`
deletes and re-inserts the band table on every save, so every id changes and an id-keyed form would
silently discard the edit. That reasoning is in `schedule/actions.ts`'s header and stays true after
the move.

### (a′) FIELD EDIT, but **not** on a Schedule Group

| # | action | file | what it writes | scope |
|---|---|---|---|---|
| a′1 | `setAttendancePolicyAction` | `attendance-policy/schedule/work-schedule-form.tsx` | one **company's** working week, hours and break | ONE COMPANY (`attendance_policy`) |

This is the single most load-bearing row in the table. It is a plain field edit, but its record is a
**company**, not a Schedule Group. It therefore **cannot** move onto a per-group page, and a
Save/Discard that enclosed both it and (a1)/(a2) would span two different records.

### (b) RECORD LIFECYCLE — must never sit under a shared Save/Discard

| # | action | file | why (b) | reversible by re-posting? |
|---|---|---|---|---|
| b1 | `createAttendanceRuleAction` | `rules/rule-form.tsx` | rule 1 — creates a row | no |
| b2 | `copyAttendanceRuleAction` | `schedule-group-card.tsx` | rule 1 — creates a row (and its band rows) | no |
| b3 | `deleteAttendanceRuleAction` | `schedule-group-card.tsx` | rule 1 — destroys a row, permanently | **no** |
| b4 | `setAttendanceRuleStatusAction` | `schedule-group-card.tsx` | rule 2 — active ⇄ inactive | yes, but it is an existence-like state |
| b5 | `revokeDeviceAction` | `work-schedule-overtime-card.tsx` | rule 2 — revokes a registered clocking device | no |
| b6 | `updateAttendanceRuleAction` | `rules/rule-form.tsx` | rules 3 **and** 4 — see below | **no** |

#### b6 is the finding this audit exists for

`updateAttendanceRuleAction` looks like a field edit. It is not, on two counts, and both are measured
in `core/attendance-rule.ts`:

- **Rule 3 — the service stamps a date the operator cannot type.**
  `resolveDeductionStart` (`core/attendance-rule.ts:645`) returns `null` when `applyDeductions` is
  off, keeps an already-on rule's stored date, and otherwise returns `todayInKualaLumpur()`. So
  switching deductions **off** clears `deductions_effective_from`, and switching them back on stamps
  **today** — not the date that was there before. A "Discard Changes" beside this switch would appear
  to undo a toggle and would in fact **move the date a deduction starts applying from**, which is the
  money-adjacent invariant migration 0394's CHECK constraint exists to protect.
- **Rule 4 — it replaces the overtime band table wholesale.**
  `updateAttendanceRule` deletes every `attendance_rule_ot_row` for the rule and re-inserts from the
  submission. The bands carry the rates. A partial submission does not merge; it replaces.

`schedule/actions.ts`'s own header records what happened the last time this was underestimated: a
form carrying only the two grace periods, posted to `updateAttendanceRuleAction`, would have saved
`name: ''`, turned the deduction switch **off**, and **deleted every overtime band** — silently,
because an absent checkbox and an unticked one are the same bytes.

---

## 4. The verdict

**Five of the nine actions are bucket (b), three of them irreversibly, and one of the four (a) rows
belongs to a different record.** So:

> **No screen-wide Save, and therefore no screen-wide Discard, is introduced by this item.**
> `components/tab-save-scope.tsx` is **not** mounted on the Schedule screens.

Each section keeps the Save it has. That is not a smaller change than the reporter asked for — they
asked for a page per Schedule Group and for a save to leave them where they are, not for one button
that saves everything. Giving them one button would have put Delete, Duplicate, Deactivate, Revoke
and the deduction stamp within reach of a Discard that cannot honestly undo any of them.

### Where each form ends up

| form | today | after 665de026 |
|---|---|---|
| a1 `saveScheduleGroupAttendanceAction` | Attendance **tab**, group picker | **Edit Schedule** page for that group |
| a2 `saveScheduleGroupOvertimeAction` | Overtime **tab**, group picker | **Edit Schedule** page for that group |
| b6 `updateAttendanceRuleAction` | `?editGroup=` panel over the General tab | **Edit Schedule** page for that group |
| b1 `createAttendanceRuleAction` | `?editGroup=new` panel over the General tab | **Add Schedule** page |
| b2 `copyAttendanceRuleAction` | list row | **stays on the list** |
| b3 `deleteAttendanceRuleAction` | list row (behind `ConfirmSubmit`) | **stays on the list**, still behind `ConfirmSubmit` |
| b4 `setAttendanceRuleStatusAction` | list row | **stays on the list** |
| b5 `revokeDeviceAction` | Work Schedule & Overtime Rates card | **stays on the list page** — it is tenant-wide, not per-group |
| a′1 `setAttendancePolicyAction` | `?policy=` panel over the General tab | **stays on the list page** — its record is a COMPANY |

The three lifecycle actions that act on a row **from** the list (b2, b3, b4) stay on the list, where
the row is. Moving Delete onto the per-group page would mean the page deletes itself.

---

## 5. ⚠️ What the approved plan overstates, measured

The plan tells the reporter that **all** the setting sections move onto the per-group page, naming
"general, holidays, overtime, attendance, requests, notifications". Measured against `main`:

1. **Only three of the six tabs have a panel at all.** `page.tsx:733` reads
   `panels={{ general, attendance, overtime }}`. Holiday, Request and Notification render the shell's
   `notBuiltYet` label and nothing else. They move as **named, honest placeholders**; no control is
   drawn for a setting nothing stores (the page header's own audit forbids it, and names rotation,
   the duty-roster controls and the monthly OT cap as the settings that are **not stored anywhere**).
   `app/admin/attendance/schedule/tabs.ts`'s header comment claims *"ONLY `general` HAS A PANEL"* —
   that was true at r263 and **r277 made it false**. It is corrected in this round.

2. **The General tab is the one tab that cannot move, and it is four fifths of the screen.** Of its
   five cards, exactly one is per-Schedule-Group:

   | card | record it belongs to | can it move to a per-group page? |
   |---|---|---|
   | Shifts available | the **tenant's** shift library | no |
   | Schedule Group (the list) | the list itself | it **becomes** the list |
   | Company Policy Settings | one row per **company** (`attendance_policy`) | no |
   | Work Schedule & Overtime Rates | **tenant** OT rates, backup coverage, registered devices | no |
   | Not configured here | a statement about the **product**, not a record | no |

   So the per-group page's "General" section is not the General tab. It is the Schedule Group's own
   identity — name, description, status, allowed shifts, the deduction switch and the overtime ladder
   — which is what `rules/rule-form.tsx` already edits. The four cards that are **not** group-shaped
   stay on the list page. Deleting them would silently retire four working screens and break the two
   redirect stubs (`/admin/attendance-policy`, `/admin/attendance-policy/schedule`) that r301 pointed
   at them.

3. **There is a seventh section, and it is the only genuinely new one.** The reporter listed
   "Working Day / Schedule Pattern" seventh. `07ebd04d` (r331, migration 0483) put
   `weekly_pattern` / `half_pattern` / `off_pattern` on `attendance_rule` with two CHECK constraints,
   and `core/attendance-rule.ts` already exposes and validates them (`normalizeWeekPattern`, `:471`).
   **No screen reads or edits them** — every hit in `app/` and `components/` is on the *shift's*
   pattern. This item builds that section. Everything else is relocation.

---

## 6. The two CHECK constraints the new section must never be able to violate

Migration 0483, mirrored in `db/schema.ts:3793-3805`:

| constraint | meaning | how the form makes it unreachable |
|---|---|---|
| `attendance_rule_day_kinds_disjoint` | no weekday in two of Full / Half / Off | **structurally impossible**: the control is one `<select>` per weekday posting exactly one of `full` \| `half` \| `off` \| `rest`, so a day cannot be in two lists. (The same shape `components/shift-time-fields.tsx` uses for the shift, decoded the same way.) |
| `attendance_rule_off_needs_working_day` | a group that declares Off days must declare at least one working day | **reachable** — every day set to Off/Rest posts it. `normalizeWeekPattern` throws a readable refusal before the DB is touched; the action surfaces it on the page with what was typed intact. |

"All three empty" stays legal and is what every pre-0483 row holds, including the un-deletable
Standard group — whose blank week is load-bearing: it is the fallback for every shift whose `rule_id`
is NULL, so a week on it would be imposed on every ungrouped shift in the tenant
(`core/week-pattern.ts weekPatternFor` — note `db/schema.ts:3769` still names `core/attendance.ts`, which r331 made stale when the helper moved).
