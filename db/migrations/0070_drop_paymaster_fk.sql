-- ADR-0029: drop the person→employment FK that an earlier cut of 0069 added. A person→employment FK
-- closes a person↔employment cycle that deadlocks the parallel TRUNCATE ... CASCADE the test harness uses
-- (and complicates insert ordering). The designated paymaster is an app-validated soft reference instead.
ALTER TABLE "person" DROP CONSTRAINT IF EXISTS "person_designated_paymaster_fk";
