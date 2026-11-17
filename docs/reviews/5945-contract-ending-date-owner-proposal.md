# Truthful historical Contract endings and legacy owner fallback

Unapplied proposal. Automatic approval review blocked the previous combined native date/owner write. No 5945 migration, constructor or signing-owner change has been applied.

The exact companion SQL uses the actual released-letter timestamp as the recorded notice date, preserving the real contract end as last day. The shared-contract constructor would permit lastDay < noticeDate ONLY after its existing private intent matches case/run/step/person/company/actual released letter and all inputs. The pending native Offboarding case would carry contractSharedNoticeReviewRequired=true so People Ops reviews actual dates. Manual, legacy Contract, Probation and Resignation constructor chronology stays unchanged. No date is clamped backwards; no Personnel/Payroll termination or clearance is written.

The second SQL definition preserves the existing shared function OID and ACL: no rename, new grant or dynamic dispatch. Only subjectType=contract gains first Review OR Approve fallback for legacy documents without an explicit owner; every other subject retains Review-only fallback. Explicit owners still win and all native actor/UID/PID checks remain. The matching pure signing helper would use the same Contract-only predicate. It does not grant a new group, role, person or substitute employee signer.

Required source patch in packs/lifecycle/v9/service.ts: change the chronology refusal to input.lastDay < input.noticeDate && contractSource?.kind !== 'shared-contract'; retain the later exact native intent validation. Add contractSharedNoticeReviewRequired:input.noticeDate>input.lastDay on the shared-contract case only. UI must display the actual recorded notice and last day plus the review notice. The type is optional on native V9 Case.

Hosted checks must prove past/current/future ending dates, actual release timestamp, unchanged all other constructor chronology, exact released-letter source, original owner ACL/function OID, legacy Approve-only ownership, no cross-subject policy change, concurrency/idempotence and unchanged Personnel/Payroll. Approval does not approve merge, staging installation or release.
