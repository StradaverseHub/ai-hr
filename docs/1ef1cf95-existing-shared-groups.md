# Shared Leave Groups as configured BEFORE the 1ef1cf95 reset

Captured from production on 2026-08-01, before migration `0339` drops
`scheme_leave_combined_limit` / `_member`.

The approved plan for `1ef1cf95` promises the reporter this list so they can recreate their groups
under the new leave-type-level structure. **Do not run the reset until this has been sent to them.**

## What exists today — ONE group, 7 member leave types

| Field | Value |
| --- | --- |
| Group name | **Special Leave** |
| Shared annual limit | **10.00 days** |
| Maximum per application | **not set** |
| Owning benefit scheme | **GRADE H (Permanent)** |

Member leave types:

| Code | Name |
| --- | --- |
| CGL | Caregiver Leave |
| CPL | Compassionate Leave |
| EXM | Examination Leave |
| GD  | Graduation Leave |
| MRL | Marriage Leave |
| NDL | Natural Disaster Leave |
| STD | Study Leave |

## Two things the reporter should be told, because neither is obvious from their request

1. **The group currently applies to ONE benefit scheme — GRADE H (Permanent) — not to everyone.**
   That is the direct consequence of shared groups living under a benefit scheme, and it is precisely
   what the redesign removes: after `1ef1cf95` a group is tenant-level and applies wherever its member
   leave types are used. So recreating "Special Leave" under the new structure will widen it from one
   scheme to the whole tenant. **That is the intended effect of the change they asked for, but it IS a
   behaviour change for everyone outside GRADE H (Permanent), and they should confirm it.**

2. **Maximum per application is not configured today.** The reporter's own description asks for a
   3-day cap per application. The column exists (added r82) but is NULL on this row, so no per-
   application cap is being enforced right now. They will need to set it when recreating the group.

## Verbatim source

```
GROUP|Special Leave|total_days=10.00|max_per_application=(none)|owning_scheme=GRADE H (Permanent)
  MEMBER|CGL|Caregiver Leave
  MEMBER|CPL|Compassionate Leave
  MEMBER|EXM|Examination Leave
  MEMBER|GD|Graduation Leave
  MEMBER|MRL|Marriage Leave
  MEMBER|NDL|Natural Disaster Leave
  MEMBER|STD|Study Leave
```

Query used:

```sql
select c.name, c.total_limit_days, c.max_days_per_application, bs.name
from scheme_leave_combined_limit c
left join benefit_scheme bs on bs.id = c.benefit_scheme_id;

select lt.code, lt.name
from scheme_leave_combined_limit_member m
join leave_type lt on lt.id = m.leave_type_id
order by lt.code;
```
