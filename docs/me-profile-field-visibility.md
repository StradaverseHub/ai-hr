# My Profile: shared Personnel visibility and update routes

Approved cf588903 replaces the old six-tab/legacy-address/Today presentation. All eleven Personnel tabs
remain in their canonical order: Profile, Family, Employment, Employment History, Attendance,
Bank & Statutory, Payroll, Leave, Documents, Qualification and Others.

Each stable Personnel descriptor below has an explicit ESS disposition. Import/report eligibility does
not grant employee access. Visible means an authorized own fact, not access to its administrative writer;
missing/ambiguous historical evidence is Unavailable, not today's value or invented zero. Dedicated
Payroll/document/Leave/Attendance owners retain their module, release and visibility guards.

One Request to Edit, Save and Cancel spans tabs. Only touched permitted fields are submitted. Saved
contacts and waiting proposals remain distinct, masked as appropriate. Exact record IDs are rechecked;
Primary/Highest/child-relief changes remain canonical owner operations. HR decides without self-approval.

The legacy request set contains twenty-four fields: seventeen on Profile and seven on Bank & Statutory.
Legacy `all` and arrays retain the previous request semantics and finite direct contacts/current-primary
five fields, even for legacy `[]` (no requests). New complete saves use `{version:2,fields:[...]}` in the
same setting; v2 empty and View Only close those direct rights too. New fields default View Only.

Canonical Permanent/Correspondence are shown and proposed through their owner. Legacy-only/conflicting
addresses remain explicit read-only reconciliation evidence; no silent copy/drop. HR document repository
metadata is protected; Documents retains only existing released own outputs, review and resignation routes.

This is an implementation inventory, not evidence of verified UI or security acceptance. Types, tests,
actual roles, six locales, themes, narrow viewport, keyboard, save/reopen and approval remain pending the
coordinated verification window. SQL0560 is the centrally reserved unapplied Profile scope migration.

| Stable Personnel field | Tab | ESS visibility | Update route | Reason |
| --- | --- | --- | --- | --- |
| `profile.personal_details.employeecode` | Profile | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `profile.personal_details.salutation` | Profile | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `profile.personal_details.fullname` | Profile | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `profile.personal_details.firstname` | Profile | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `profile.personal_details.lastname` | Profile | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `profile.personal_details.preferredname` | Profile | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `profile.personal_details.nationality` | Profile | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `profile.personal_details.religion` | Profile | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `profile.personal_details.race` | Profile | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `profile.personal_details.dateofbirth` | Profile | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `profile.personal_details.age` | Profile | Visible | viewOnly | Calculated from recorded birth date and viewing date. |
| `profile.personal_details.gender` | Profile | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `profile.personal_details.maritalstatus` | Profile | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `profile.personal_details.status` | Profile | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `profile.personal_details.photo` | Profile | Visible | specialist | Photo stays under the guarded file owner. |
| `profile.identity_and_passport.icnumber` | Profile | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `profile.identity_and_passport.oldicnumber` | Profile | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `profile.identity_and_passport.passportnumber` | Profile | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `profile.identity_and_passport.passportissuedate` | Profile | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `profile.identity_and_passport.passportexpirydate` | Profile | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `profile.identity_and_passport.passportissuingcountry` | Profile | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `profile.identity_and_passport.passportissuingcountrycode` | Profile | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `profile.identity_and_passport.passportremark` | Profile | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `profile.contact_and_permanent_address.primaryemail` | Profile | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `profile.contact_and_permanent_address.phone` | Profile | Visible | immediate | Existing low-risk contact owner. |
| `profile.contact_and_permanent_address.homephone` | Profile | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `profile.contact_and_permanent_address.personalemail` | Profile | Visible | immediate | Existing low-risk contact owner. |
| `profile.contact_and_permanent_address.permanentaddressline1` | Profile | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `profile.contact_and_permanent_address.permanentaddressline2` | Profile | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `profile.contact_and_permanent_address.permanentaddressline3` | Profile | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `profile.contact_and_permanent_address.permanentpostcode` | Profile | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `profile.contact_and_permanent_address.permanentcity` | Profile | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `profile.contact_and_permanent_address.permanentstate` | Profile | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `profile.contact_and_permanent_address.permanentcountry` | Profile | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `profile.correspondence_address.correspondenceaddressline1` | Profile | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `profile.correspondence_address.correspondenceaddressline2` | Profile | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `profile.correspondence_address.correspondenceaddressline3` | Profile | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `profile.correspondence_address.correspondencepostcode` | Profile | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `profile.correspondence_address.correspondencecity` | Profile | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `profile.correspondence_address.correspondencestate` | Profile | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `profile.correspondence_address.correspondencecountry` | Profile | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `profile.correspondence_address.correspondencemobilephone` | Profile | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `profile.correspondence_address.correspondencehomephone` | Profile | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `profile.correspondence_address.copypermanentaddress` | Profile | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `profile.emergency_contact.fullname` | Profile | Visible | approval | Employee proposal; authorized HR approval uses the canonical Emergency Contact owner. |
| `profile.emergency_contact.relationship` | Profile | Visible | approval | Employee proposal; authorized HR approval uses the canonical Emergency Contact owner. |
| `profile.emergency_contact.mobilephone` | Profile | Visible | approval | Employee proposal; authorized HR approval uses the canonical Emergency Contact owner. |
| `profile.emergency_contact.homephone` | Profile | Visible | approval | Employee proposal; authorized HR approval uses the canonical Emergency Contact owner. |
| `profile.emergency_contact.priority` | Profile | Visible | approval | Employee proposal; authorized HR approval uses the canonical Emergency Contact owner. |
| `profile.emergency_contact.address` | Profile | Visible | approval | Employee proposal; authorized HR approval uses the canonical Emergency Contact owner. |
| `profile.emergency_contact.remarks` | Profile | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `family.family_and_dependents.relationship` | Family | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `family.family_and_dependents.fullname` | Family | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `family.family_and_dependents.gender` | Family | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `family.family_and_dependents.dateofbirth` | Family | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `family.family_and_dependents.age` | Family | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `family.family_and_dependents.phone` | Family | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `family.family_and_dependents.icorpassport` | Family | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `family.family_and_dependents.icorpassport_8` | Family | Protected | viewOnly | Duplicate conditional presentation of the same family identity field; the canonical descriptor is displayed once. |
| `family.family_and_dependents.passportnumber` | Family | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `family.family_and_dependents.residentialaddress` | Family | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `family.family_and_dependents.marriagedate` | Family | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `family.family_and_dependents.marriagestatus` | Family | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `family.family_and_dependents.occupation` | Family | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `family.family_and_dependents.companyname` | Family | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `family.family_and_dependents.employeraddress` | Family | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `family.family_and_dependents.spouseworking` | Family | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `family.family_and_dependents.isbeneficiary` | Family | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `family.family_and_dependents.isdeceased` | Family | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `family.family_and_dependents.isstudent` | Family | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `family.family_and_dependents.schoolname` | Family | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `family.family_and_dependents.studylevel` | Family | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `family.family_and_dependents.studycountry` | Family | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `family.family_and_dependents.childreliefcategory` | Family | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `family.family_and_dependents.childtaxrelief` | Family | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `family.family_and_dependents.childreliefpercentage` | Family | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `family.family_and_dependents.countstowardrelief` | Family | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `family.family_and_dependents.remarks` | Family | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `employment.organisation_assignment.companyname` | Employment | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `employment.organisation_assignment.businessunitname` | Employment | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `employment.organisation_assignment.departmentname` | Employment | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `employment.organisation_assignment.positionname` | Employment | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `employment.organisation_assignment.gradename` | Employment | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `employment.organisation_assignment.employmenttype` | Employment | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `employment.additional_organisation_labels.orgdivision` | Employment | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `employment.additional_organisation_labels.orgbranch` | Employment | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `employment.additional_organisation_labels.orgregion` | Employment | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `employment.additional_organisation_labels.orgline` | Employment | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `employment.additional_organisation_labels.orgsection` | Employment | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `employment.additional_organisation_labels.orgteam` | Employment | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `employment.additional_organisation_labels.orgbase` | Employment | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `employment.additional_organisation_labels.employmentcategory` | Employment | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `employment.employment_dates_and_service.hiredon` | Employment | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `employment.employment_dates_and_service.joindate` | Employment | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `employment.employment_dates_and_service.groupservice` | Employment | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `employment.employment_dates_and_service.companyservice` | Employment | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `employment.employment_dates_and_service.yearofservice` | Employment | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `employment.employment_dates_and_service.probationvalue` | Employment | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `employment.employment_dates_and_service.probationunit` | Employment | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `employment.employment_dates_and_service.extendedprobationvalue` | Employment | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `employment.employment_dates_and_service.extendedprobationunit` | Employment | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `employment.employment_dates_and_service.finalconfirmationdate` | Employment | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `employment.employment_dates_and_service.contractstartdate` | Employment | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `employment.employment_dates_and_service.contractenddate` | Employment | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `employment.employment_dates_and_service.contractremark` | Employment | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `employment.employment_dates_and_service.noticebeforeconfirmationvalue` | Employment | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `employment.employment_dates_and_service.noticebeforeconfirmationunit` | Employment | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `employment.employment_dates_and_service.noticeafterconfirmationvalue` | Employment | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `employment.employment_dates_and_service.noticeafterconfirmationunit` | Employment | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `employment.employment_dates_and_service.tenderresignationdate` | Employment | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `employment.employment_dates_and_service.resignationdate` | Employment | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `employment.employment_dates_and_service.lastworkingdate` | Employment | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `employment.direct_superior_and_history.employeecode` | Employment | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `employment.direct_superior_and_history.fullname` | Employment | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `employment.direct_superior_and_history.employeecode_3` | Employment | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `employment.direct_superior_and_history.fullname_4` | Employment | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `employment.direct_superior_and_history.validfrom` | Employment | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `employment.direct_superior_and_history.validto` | Employment | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `employment.approval_delegations.employeecode` | Employment | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `employment.approval_delegations.fullname` | Employment | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `employment.approval_delegations.validfrom` | Employment | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `employment.approval_delegations.validto` | Employment | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `employment_history.event_information.kind` | Employment History | Visible | viewOnly | Recorded own employment event; private reasons and actors are withheld. |
| `employment_history.event_information.effectivefrom` | Employment History | Visible | viewOnly | Recorded own employment event; private reasons and actors are withheld. |
| `employment_history.event_information.enddate` | Employment History | Visible | viewOnly | Recorded own employment event; private reasons and actors are withheld. |
| `employment_history.event_information.lastworkingdate` | Employment History | Visible | viewOnly | Recorded own employment event; private reasons and actors are withheld. |
| `employment_history.event_information.recordedbyname` | Employment History | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `employment_history.event_information.recordedat` | Employment History | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `employment_history.event_information.remarks` | Employment History | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `employment_history.event_information.status` | Employment History | Visible | viewOnly | Recorded own employment event; private reasons and actors are withheld. |
| `employment_history.event_information.jobtitle` | Employment History | Visible | viewOnly | Recorded own employment event; private reasons and actors are withheld. |
| `employment_history.event_information.basicsalary` | Employment History | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `employment_history.event_information.terminationreason` | Employment History | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `employment_history.event_information.terminationtype` | Employment History | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `employment_history.event_information.resignationdate` | Employment History | Visible | viewOnly | Recorded own employment event; private reasons and actors are withheld. |
| `employment_history.event_information.noticeserveddays` | Employment History | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `employment_history.event_information.blacklisted` | Employment History | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `employment_history.event_information.correctionreason` | Employment History | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `employment_history.event_information.reversedbyname` | Employment History | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `employment_history.event_information.reversedat` | Employment History | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `employment_history.event_information.reversalreason` | Employment History | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `employment_history.before_changes_and_after_changes.companyname` | Employment History | Visible | viewOnly | Recorded before/after own organisation fact; no current-as-history substitution. |
| `employment_history.before_changes_and_after_changes.businessunitname` | Employment History | Visible | viewOnly | Recorded before/after own organisation fact; no current-as-history substitution. |
| `employment_history.before_changes_and_after_changes.orgdivision` | Employment History | Visible | viewOnly | Recorded before/after own organisation fact; no current-as-history substitution. |
| `employment_history.before_changes_and_after_changes.departmentname` | Employment History | Visible | viewOnly | Recorded before/after own organisation fact; no current-as-history substitution. |
| `employment_history.before_changes_and_after_changes.positionname` | Employment History | Visible | viewOnly | Recorded before/after own organisation fact; no current-as-history substitution. |
| `employment_history.before_changes_and_after_changes.gradename` | Employment History | Visible | viewOnly | Recorded before/after own organisation fact; no current-as-history substitution. |
| `employment_history.before_changes_and_after_changes.employmenttype` | Employment History | Visible | viewOnly | Recorded before/after own organisation fact; no current-as-history substitution. |
| `employment_history.before_changes_and_after_changes.manageremployeecode` | Employment History | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `employment_history.before_changes_and_after_changes.managername` | Employment History | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `employment_history.before_changes_and_after_changes.basicsalary` | Employment History | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `employment_history.before_changes_and_after_changes.currency` | Employment History | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `employment_history.before_changes_and_after_changes.paymode` | Employment History | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `employment_history.before_changes_and_after_changes.paymentterm` | Employment History | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `employment_history.before_changes_and_after_changes.employmentcategory` | Employment History | Visible | viewOnly | Recorded before/after own organisation fact; no current-as-history substitution. |
| `employment_history.before_changes_and_after_changes.orgregion` | Employment History | Visible | viewOnly | Recorded before/after own organisation fact; no current-as-history substitution. |
| `employment_history.before_changes_and_after_changes.orgbranch` | Employment History | Visible | viewOnly | Recorded before/after own organisation fact; no current-as-history substitution. |
| `employment_history.before_changes_and_after_changes.orgteam` | Employment History | Visible | viewOnly | Recorded before/after own organisation fact; no current-as-history substitution. |
| `employment_history.before_changes_and_after_changes.orgsection` | Employment History | Visible | viewOnly | Recorded before/after own organisation fact; no current-as-history substitution. |
| `employment_history.before_changes_and_after_changes.orgline` | Employment History | Visible | viewOnly | Recorded before/after own organisation fact; no current-as-history substitution. |
| `employment_history.before_changes_and_after_changes.orgbase` | Employment History | Visible | viewOnly | Recorded before/after own organisation fact; no current-as-history substitution. |
| `employment_history.before_changes_and_after_changes.locationname` | Employment History | Visible | viewOnly | Recorded before/after own organisation fact; no current-as-history substitution. |
| `employment_history.original_hire_details_and_corrections.businessunitname` | Employment History | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `employment_history.original_hire_details_and_corrections.departmentname` | Employment History | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `employment_history.original_hire_details_and_corrections.positionname` | Employment History | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `employment_history.original_hire_details_and_corrections.costcentername` | Employment History | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `employment_history.original_hire_details_and_corrections.locationname` | Employment History | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `employment_history.original_hire_details_and_corrections.manageremployeecode` | Employment History | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `employment_history.original_hire_details_and_corrections.managername` | Employment History | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `employment_history.original_hire_details_and_corrections.originalvalue` | Employment History | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `employment_history.original_hire_details_and_corrections.correctedvalue` | Employment History | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `employment_history.original_hire_details_and_corrections.recordedbyname` | Employment History | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `employment_history.original_hire_details_and_corrections.recordedat` | Employment History | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `employment_history.original_hire_details_and_corrections.reason` | Employment History | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `attendance.holiday_calendar_and_schedule.holidaygroupname` | Attendance | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `attendance.holiday_calendar_and_schedule.schedulegroupname` | Attendance | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `attendance.clocking_and_attendance_photo.geofencingenabled` | Attendance | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `attendance.clocking_and_attendance_photo.clockinglocationcode` | Attendance | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `attendance.clocking_and_attendance_photo.clockinglocationname` | Attendance | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `attendance.clocking_and_attendance_photo.clockinglocationaddress` | Attendance | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `attendance.clocking_and_attendance_photo.geofenceradiusm` | Attendance | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `attendance.clocking_and_attendance_photo.clockinglocationstatus` | Attendance | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `attendance.clocking_and_attendance_photo.cardid` | Attendance | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `attendance.clocking_and_attendance_photo.attendancephotosetting` | Attendance | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `attendance.work_location_and_shift_arrangement.locationcode` | Attendance | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `attendance.work_location_and_shift_arrangement.locationname` | Attendance | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `attendance.work_location_and_shift_arrangement.locationeffectivefrom` | Attendance | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `attendance.work_location_and_shift_arrangement.shifttype` | Attendance | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `attendance.work_location_and_shift_arrangement.backupshiftcode` | Attendance | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `attendance.work_location_and_shift_arrangement.backupshiftname` | Attendance | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `attendance.work_location_and_shift_arrangement.shifteffectivefrom` | Attendance | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `attendance.work_location_and_shift_arrangement.previousshiftcode` | Attendance | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `attendance.work_location_and_shift_arrangement.previousshiftname` | Attendance | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `attendance.work_location_and_shift_arrangement.newshiftcode` | Attendance | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `attendance.work_location_and_shift_arrangement.newshiftname` | Attendance | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `attendance.work_location_and_shift_arrangement.changedbyname` | Attendance | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `attendance.work_location_and_shift_arrangement.changedat` | Attendance | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `bank_statutory.bank_information.bankname` | Bank & Statutory | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `bank_statutory.bank_information.bankaccountno` | Bank & Statutory | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `bank_statutory.bank_information.enablecustomholdername` | Bank & Statutory | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `bank_statutory.bank_information.customholdername` | Bank & Statutory | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `bank_statutory.bank_information.enablecustomholderid` | Bank & Statutory | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `bank_statutory.bank_information.customholderid` | Bank & Statutory | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `bank_statutory.epf_contribution.epfnumber` | Bank & Statutory | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `bank_statutory.epf_contribution.epfcitizenship` | Bank & Statutory | Visible | specialist | Country-pack selection or derived statutory fact; no generic employee writer. |
| `bank_statutory.epf_contribution.epfmode` | Bank & Statutory | Protected | specialist | Internal persisted calculation enum; the canonical EPF UI category/election and applicable employee figures are shown instead. |
| `bank_statutory.epf_contribution.epfemployeerate` | Bank & Statutory | Visible | specialist | Country-pack selection or derived statutory fact; no generic employee writer. |
| `bank_statutory.epf_contribution.epfemployerrate` | Bank & Statutory | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `bank_statutory.epf_contribution.epfemployeeamount` | Bank & Statutory | Visible | specialist | Country-pack selection or derived statutory fact; no generic employee writer. |
| `bank_statutory.epf_contribution.epfemployeramount` | Bank & Statutory | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `bank_statutory.epf_contribution.epfmanualreason` | Bank & Statutory | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `bank_statutory.epf_contribution.employerbearsepf` | Bank & Statutory | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `bank_statutory.socso_eis_and_others_statutory.socsonumber` | Bank & Statutory | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `bank_statutory.socso_eis_and_others_statutory.socsocategory` | Bank & Statutory | Visible | specialist | Country-pack selection or derived statutory fact; no generic employee writer. |
| `bank_statutory.socso_eis_and_others_statutory.eiscategory` | Bank & Statutory | Visible | specialist | Country-pack selection or derived statutory fact; no generic employee writer. |
| `bank_statutory.socso_eis_and_others_statutory.subjecttoskbbk` | Bank & Statutory | Visible | specialist | Country-pack selection or derived statutory fact; no generic employee writer. |
| `bank_statutory.socso_eis_and_others_statutory.employerbearssocso` | Bank & Statutory | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `bank_statutory.socso_eis_and_others_statutory.employerbearseis` | Bank & Statutory | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `bank_statutory.socso_eis_and_others_statutory.employerbearsskbbk` | Bank & Statutory | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `bank_statutory.socso_eis_and_others_statutory.hrdfsubject` | Bank & Statutory | Visible | specialist | Country-pack selection or derived statutory fact; no generic employee writer. |
| `bank_statutory.income_tax_pcb.taxnumber` | Bank & Statutory | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `bank_statutory.income_tax_pcb.taxcategory` | Bank & Statutory | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `bank_statutory.income_tax_pcb.taxresidency` | Bank & Statutory | Visible | specialist | Country-pack selection or derived statutory fact; no generic employee writer. |
| `bank_statutory.income_tax_pcb.disabledindividual` | Bank & Statutory | Visible | specialist | Country-pack selection or derived statutory fact; no generic employee writer. |
| `bank_statutory.income_tax_pcb.disabledspouse` | Bank & Statutory | Visible | specialist | Country-pack selection or derived statutory fact; no generic employee writer. |
| `bank_statutory.income_tax_pcb.childreliefmode` | Bank & Statutory | Visible | specialist | Country-pack selection or derived statutory fact; no generic employee writer. |
| `bank_statutory.income_tax_pcb.numchildren` | Bank & Statutory | Visible | approval | Manual-mode qualifying-child head-count proposal uses the tax owner after approval. Automatic modes show the canonical qualifying head count read-only; this is neither total Family records nor weighted relief units. |
| `bank_statutory.income_tax_pcb.qualifyingchildren` | Bank & Statutory | Visible | specialist | Country-pack selection or derived statutory fact; no generic employee writer. |
| `bank_statutory.income_tax_pcb.childreliefamount` | Bank & Statutory | Visible | specialist | Country-pack selection or derived statutory fact; no generic employee writer. |
| `bank_statutory.income_tax_pcb.employerbearstax` | Bank & Statutory | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `bank_statutory.income_tax_pcb.employername` | Bank & Statutory | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `bank_statutory.income_tax_pcb.selectionconfirmationrequired` | Bank & Statutory | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `bank_statutory.income_tax_pcb.item` | Bank & Statutory | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `bank_statutory.income_tax_pcb.category` | Bank & Statutory | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `bank_statutory.income_tax_pcb.share` | Bank & Statutory | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `bank_statutory.income_tax_pcb.qualifyingunits` | Bank & Statutory | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `bank_statutory.income_tax_pcb.reliefamount` | Bank & Statutory | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `bank_statutory.declared_child_relief_table.under18full` | Bank & Statutory | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `bank_statutory.declared_child_relief_table.under18half` | Bank & Statutory | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `bank_statutory.declared_child_relief_table.preuniversityfull` | Bank & Statutory | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `bank_statutory.declared_child_relief_table.preuniversityhalf` | Bank & Statutory | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `bank_statutory.declared_child_relief_table.tertiaryfull` | Bank & Statutory | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `bank_statutory.declared_child_relief_table.tertiaryhalf` | Bank & Statutory | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `bank_statutory.declared_child_relief_table.disabledfull` | Bank & Statutory | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `bank_statutory.declared_child_relief_table.disabledhalf` | Bank & Statutory | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `bank_statutory.declared_child_relief_table.disabledstudyfull` | Bank & Statutory | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `bank_statutory.declared_child_relief_table.disabledstudyhalf` | Bank & Statutory | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `payroll.basic_salary_and_salary_history.validfrom` | Payroll | Visible | specialist | Own compensation projection; salary revisions remain an authorized Payroll workflow. |
| `payroll.basic_salary_and_salary_history.basicsalary` | Payroll | Visible | specialist | Own compensation projection; salary revisions remain an authorized Payroll workflow. |
| `payroll.basic_salary_and_salary_history.currency` | Payroll | Visible | specialist | Own compensation projection; salary revisions remain an authorized Payroll workflow. |
| `payroll.basic_salary_and_salary_history.previoussalary` | Payroll | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `payroll.basic_salary_and_salary_history.incrementamount` | Payroll | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `payroll.basic_salary_and_salary_history.incrementpercent` | Payroll | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `payroll.basic_salary_and_salary_history.paymode` | Payroll | Visible | specialist | Own compensation projection; salary revisions remain an authorized Payroll workflow. |
| `payroll.basic_salary_and_salary_history.paymentterm` | Payroll | Visible | specialist | Own compensation projection; salary revisions remain an authorized Payroll workflow. |
| `payroll.basic_salary_and_salary_history.rateamount` | Payroll | Visible | specialist | Own compensation projection; salary revisions remain an authorized Payroll workflow. |
| `payroll.basic_salary_and_salary_history.remarks` | Payroll | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `payroll.basic_salary_and_salary_history.status` | Payroll | Visible | specialist | Own compensation projection; salary revisions remain an authorized Payroll workflow. |
| `payroll.payment_method_and_payroll_policy.paymentmethod` | Payroll | Visible | specialist | Own pay information only; no payroll configuration or transaction edits. |
| `payroll.payment_method_and_payroll_policy.payrollpolicyname` | Payroll | Visible | specialist | Own pay information only; no payroll configuration or transaction edits. |
| `payroll.pay_items.componentname` | Payroll | Visible | specialist | Own pay information only; no payroll configuration or transaction edits. |
| `payroll.pay_items.amount` | Payroll | Visible | specialist | Own pay information only; no payroll configuration or transaction edits. |
| `payroll.pay_items.currency` | Payroll | Visible | specialist | Own pay information only; no payroll configuration or transaction edits. |
| `payroll.pay_items.validfrom` | Payroll | Visible | specialist | Own pay information only; no payroll configuration or transaction edits. |
| `payroll.pay_items.validto` | Payroll | Visible | specialist | Own pay information only; no payroll configuration or transaction edits. |
| `payroll.pay_items.prorate` | Payroll | Visible | specialist | Own pay information only; no payroll configuration or transaction edits. |
| `payroll.pay_items.remarks` | Payroll | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `payroll.cp38_deduction.reference` | Payroll | Visible | specialist | Own pay information only; no payroll configuration or transaction edits. |
| `payroll.cp38_deduction.monthlyamount` | Payroll | Visible | specialist | Own pay information only; no payroll configuration or transaction edits. |
| `payroll.cp38_deduction.validfrom` | Payroll | Visible | specialist | Own pay information only; no payroll configuration or transaction edits. |
| `payroll.cp38_deduction.validto` | Payroll | Visible | specialist | Own pay information only; no payroll configuration or transaction edits. |
| `payroll.cp38_deduction.remarks` | Payroll | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `payroll.cp38_deduction.status` | Payroll | Visible | specialist | Own pay information only; no payroll configuration or transaction edits. |
| `payroll.leave_encashment.rawbalance` | Payroll | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `payroll.leave_encashment.autodays` | Payroll | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `payroll.leave_encashment.effectivedays` | Payroll | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `payroll.leave_encashment.asof` | Payroll | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `payroll.leave_encashment.status` | Payroll | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `payroll.leave_encashment.adjusteddays` | Payroll | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `payroll.leave_encashment.reason` | Payroll | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `payroll.previous_employment_this_year_tp3_opening_balances.year` | Payroll | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `payroll.previous_employment_this_year_tp3_opening_balances.netremuneration` | Payroll | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `payroll.previous_employment_this_year_tp3_opening_balances.epfclaimed` | Payroll | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `payroll.previous_employment_this_year_tp3_opening_balances.pcbpaid` | Payroll | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `payroll.zakat_summary.status` | Payroll | Visible | specialist | Own pay information only; no payroll configuration or transaction edits. |
| `payroll.zakat_summary.stateauthority` | Payroll | Visible | specialist | Own pay information only; no payroll configuration or transaction edits. |
| `payroll.zakat_summary.method` | Payroll | Visible | specialist | Own pay information only; no payroll configuration or transaction edits. |
| `payroll.zakat_summary.rate` | Payroll | Visible | specialist | Own pay information only; no payroll configuration or transaction edits. |
| `leave.grade_and_benefit_scheme.gradename` | Leave | Visible | viewOnly | Existing own Leave balance/benefit owner; unavailable is not zero. |
| `leave.grade_and_benefit_scheme.schemename` | Leave | Visible | viewOnly | Existing own Leave balance/benefit owner; unavailable is not zero. |
| `leave.grade_and_benefit_scheme.effectivefrom` | Leave | Visible | viewOnly | Existing own Leave balance/benefit owner; unavailable is not zero. |
| `leave.grade_and_benefit_scheme.serviceyears` | Leave | Visible | viewOnly | Existing own Leave balance/benefit owner; unavailable is not zero. |
| `leave.grade_and_benefit_scheme.leavetypename` | Leave | Visible | viewOnly | Existing own Leave balance/benefit owner; unavailable is not zero. |
| `leave.grade_and_benefit_scheme.pickedupby` | Leave | Visible | viewOnly | Existing own Leave balance/benefit owner; unavailable is not zero. |
| `leave.grade_and_benefit_scheme.days` | Leave | Visible | viewOnly | Existing own Leave balance/benefit owner; unavailable is not zero. |
| `leave.grade_and_benefit_scheme.unmatchedleavetypes` | Leave | Visible | viewOnly | Existing own Leave balance/benefit owner; unavailable is not zero. |
| `leave.leave_balance_and_breakdown.leavetypename` | Leave | Visible | viewOnly | Existing own Leave balance/benefit owner; unavailable is not zero. |
| `leave.leave_balance_and_breakdown.asof` | Leave | Visible | viewOnly | Existing own Leave balance/benefit owner; unavailable is not zero. |
| `leave.leave_balance_and_breakdown.entitlement` | Leave | Visible | viewOnly | Existing own Leave balance/benefit owner; unavailable is not zero. |
| `leave.leave_balance_and_breakdown.earnedtodate` | Leave | Visible | viewOnly | Existing own Leave balance/benefit owner; unavailable is not zero. |
| `leave.leave_balance_and_breakdown.roundedearnedtodate` | Leave | Visible | viewOnly | Existing own Leave balance/benefit owner; unavailable is not zero. |
| `leave.leave_balance_and_breakdown.broughtforward` | Leave | Visible | viewOnly | Existing own Leave balance/benefit owner; unavailable is not zero. |
| `leave.leave_balance_and_breakdown.adjustments` | Leave | Visible | viewOnly | Existing own Leave balance/benefit owner; unavailable is not zero. |
| `leave.leave_balance_and_breakdown.total` | Leave | Visible | viewOnly | Existing own Leave balance/benefit owner; unavailable is not zero. |
| `leave.leave_balance_and_breakdown.taken` | Leave | Visible | viewOnly | Existing own Leave balance/benefit owner; unavailable is not zero. |
| `leave.leave_balance_and_breakdown.pendingapproval` | Leave | Visible | viewOnly | Existing own Leave balance/benefit owner; unavailable is not zero. |
| `leave.leave_balance_and_breakdown.broughtforwardforfeited` | Leave | Visible | viewOnly | Existing own Leave balance/benefit owner; unavailable is not zero. |
| `leave.leave_balance_and_breakdown.expirydate` | Leave | Visible | viewOnly | Existing own Leave balance/benefit owner; unavailable is not zero. |
| `leave.leave_balance_and_breakdown.availablebalance` | Leave | Visible | viewOnly | Existing own Leave balance/benefit owner; unavailable is not zero. |
| `leave.leave_balance_and_breakdown.entitlementstatus` | Leave | Visible | viewOnly | Existing own Leave balance/benefit owner; unavailable is not zero. |
| `leave.leave_balance_and_breakdown.entitlementtable` | Leave | Visible | viewOnly | Existing own Leave balance/benefit owner; unavailable is not zero. |
| `leave.leave_balance_and_breakdown.sharedbalancesource` | Leave | Visible | viewOnly | Existing own Leave balance/benefit owner; unavailable is not zero. |
| `leave.entitlement_recalculation_history.effectivefrom` | Leave | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `leave.entitlement_recalculation_history.leavetypename` | Leave | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `leave.entitlement_recalculation_history.previousgradename` | Leave | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `leave.entitlement_recalculation_history.newgradename` | Leave | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `leave.entitlement_recalculation_history.reason` | Leave | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `leave.entitlement_recalculation_history.previousdays` | Leave | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `leave.entitlement_recalculation_history.newdays` | Leave | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `leave.entitlement_recalculation_history.changedays` | Leave | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `documents.employee_documents.title` | Documents | Protected | specialist | HR repository metadata is not an employee document grant. Documents retains existing released employee outputs through their dedicated guarded owners. |
| `documents.employee_documents.category` | Documents | Protected | specialist | HR repository metadata is not an employee document grant. Documents retains existing released employee outputs through their dedicated guarded owners. |
| `documents.employee_documents.description` | Documents | Protected | specialist | HR repository metadata is not an employee document grant. Documents retains existing released employee outputs through their dedicated guarded owners. |
| `documents.employee_documents.filename` | Documents | Protected | specialist | HR repository metadata is not an employee document grant. Documents retains existing released employee outputs through their dedicated guarded owners. |
| `documents.employee_documents.mimetype` | Documents | Protected | specialist | HR repository metadata is not an employee document grant. Documents retains existing released employee outputs through their dedicated guarded owners. |
| `documents.employee_documents.sizebytes` | Documents | Protected | specialist | HR repository metadata is not an employee document grant. Documents retains existing released employee outputs through their dedicated guarded owners. |
| `documents.employee_documents.createdat` | Documents | Protected | specialist | HR repository metadata is not an employee document grant. Documents retains existing released employee outputs through their dedicated guarded owners. |
| `documents.employee_documents.updatedat` | Documents | Protected | specialist | HR repository metadata is not an employee document grant. Documents retains existing released employee outputs through their dedicated guarded owners. |
| `documents.employee_documents.createdbyname` | Documents | Protected | specialist | HR repository metadata is not an employee document grant. Documents retains existing released employee outputs through their dedicated guarded owners. |
| `documents.employee_documents.updatedbyname` | Documents | Protected | specialist | HR repository metadata is not an employee document grant. Documents retains existing released employee outputs through their dedicated guarded owners. |
| `documents.employee_documents.content` | Documents | Protected | specialist | HR repository metadata is not an employee document grant. Documents retains existing released employee outputs through their dedicated guarded owners. |
| `qualification.academic_and_professional_qualifications.level` | Qualification | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `qualification.academic_and_professional_qualifications.institute` | Qualification | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `qualification.academic_and_professional_qualifications.fromym` | Qualification | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `qualification.academic_and_professional_qualifications.toym` | Qualification | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `qualification.academic_and_professional_qualifications.graduationdate` | Qualification | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `qualification.academic_and_professional_qualifications.major` | Qualification | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `qualification.academic_and_professional_qualifications.result` | Qualification | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `qualification.academic_and_professional_qualifications.description` | Qualification | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `qualification.academic_and_professional_qualifications.highest` | Qualification | Visible | approval | Employee proposal; authorized HR approval uses the canonical record owner. |
| `others.change_history.eventtype` | Others | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `others.change_history.action` | Others | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `others.change_history.highimpact` | Others | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `others.change_history.actortype` | Others | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `others.change_history.actorname` | Others | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `others.change_history.module` | Others | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `others.change_history.aggregatetype` | Others | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `others.change_history.occurredat` | Others | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `others.change_history.sequence` | Others | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `others.change_history.changedfield` | Others | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `others.change_history.previousvalue` | Others | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `others.change_history.newvalue` | Others | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `others.leave_requests.leavetypename` | Others | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `others.leave_requests.startdate` | Others | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `others.leave_requests.enddate` | Others | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `others.leave_requests.days` | Others | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `others.leave_requests.status` | Others | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `others.probation_contract_internship_review.employmenttype` | Others | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `others.probation_contract_internship_review.type` | Others | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `others.probation_contract_internship_review.enddate` | Others | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `others.probation_contract_internship_review.duedate` | Others | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `others.probation_contract_internship_review.status` | Others | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `others.probation_contract_internship_review.decision` | Others | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `others.probation_contract_internship_review.documentkind` | Others | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `others.probation_contract_internship_review.documentfilename` | Others | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `others.probation_contract_internship_review.content` | Others | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `employment_history.related_values_shown_during_hire_correction.companyname` | Employment History | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `employment_history.related_values_shown_during_hire_correction.hiredon` | Employment History | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `employment_history.related_values_shown_during_hire_correction.joindate` | Employment History | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `employment_history.related_values_shown_during_hire_correction.gradename` | Employment History | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `employment_history.related_values_shown_during_hire_correction.employmenttype` | Employment History | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `leave.eligibility_and_explanation_details.rulename` | Leave | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `leave.eligibility_and_explanation_details.state` | Leave | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `leave.eligibility_and_explanation_details.validfrom` | Leave | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `leave.eligibility_and_explanation_details.validto` | Leave | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `leave.eligibility_and_explanation_details.nonmatchreason` | Leave | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `leave.eligibility_and_explanation_details.balanceline` | Leave | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `leave.eligibility_and_explanation_details.explanation` | Leave | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `leave.eligibility_and_explanation_details.description` | Leave | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `leave.eligibility_and_explanation_details.formula` | Leave | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `profile.draft_only_saved_address_choice.sameaspermanent` | Profile | Protected | specialist | Draft creation control; not a saved employee fact. |
| `employment.draft_only_employment_fields.costcenterid` | Employment | Protected | specialist | Draft creation control; not a saved employee fact. |
| `employment.draft_only_employment_fields.internshipenddate` | Employment | Protected | specialist | Draft creation control; not a saved employee fact. |
| `employment.draft_only_employment_fields.probationenddate` | Employment | Protected | specialist | Draft creation control; not a saved employee fact. |
| `payroll.draft_initial_monthly_allowance.monthlyallowance` | Payroll | Protected | specialist | Draft creation control; not a saved employee fact. |
| `employment.employment_dates_and_service.confirmationdate` | Employment | Visible | viewOnly | Recorded own employee fact; changes use the authorized owner workflow. |
| `bank_statutory.income_tax_pcb.taxcircumstance` | Bank & Statutory | Visible | specialist | Country-pack selection or derived statutory fact; no generic employee writer. |
| `employment.direct_superior_and_history.superioremploymentid` | Employment | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `employment.approval_delegations.delegateemploymentid` | Employment | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `attendance.work_location_and_shift_arrangement.locationid` | Attendance | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `bank_statutory.epf_contribution.epfuimode` | Bank & Statutory | Visible | specialist | Country-pack selection or derived statutory fact; no generic employee writer. |
| `attendance.clocking_and_attendance_photo.clockinglocationids` | Attendance | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `attendance.work_location_and_shift_arrangement.backupshiftid` | Attendance | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `bank_statutory.income_tax_pcb.childrelieftable_under_18_full` | Bank & Statutory | Visible | specialist | Country-pack selection or derived statutory fact; no generic employee writer. |
| `bank_statutory.income_tax_pcb.childrelieftable_under_18_half` | Bank & Statutory | Visible | specialist | Country-pack selection or derived statutory fact; no generic employee writer. |
| `bank_statutory.income_tax_pcb.childrelieftable_study_preu_full` | Bank & Statutory | Visible | specialist | Country-pack selection or derived statutory fact; no generic employee writer. |
| `bank_statutory.income_tax_pcb.childrelieftable_study_preu_half` | Bank & Statutory | Visible | specialist | Country-pack selection or derived statutory fact; no generic employee writer. |
| `bank_statutory.income_tax_pcb.childrelieftable_study_tertiary_full` | Bank & Statutory | Visible | specialist | Country-pack selection or derived statutory fact; no generic employee writer. |
| `bank_statutory.income_tax_pcb.childrelieftable_study_tertiary_half` | Bank & Statutory | Visible | specialist | Country-pack selection or derived statutory fact; no generic employee writer. |
| `bank_statutory.income_tax_pcb.childrelieftable_disabled_full` | Bank & Statutory | Visible | specialist | Country-pack selection or derived statutory fact; no generic employee writer. |
| `bank_statutory.income_tax_pcb.childrelieftable_disabled_half` | Bank & Statutory | Visible | specialist | Country-pack selection or derived statutory fact; no generic employee writer. |
| `bank_statutory.income_tax_pcb.childrelieftable_disabled_study_full` | Bank & Statutory | Visible | specialist | Country-pack selection or derived statutory fact; no generic employee writer. |
| `bank_statutory.income_tax_pcb.childrelieftable_disabled_study_half` | Bank & Statutory | Visible | specialist | Country-pack selection or derived statutory fact; no generic employee writer. |
| `employment_history.original_hire_details_and_corrections.costcenterid` | Employment History | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
| `employment_history.event_information.terminationreasoncode` | Employment History | Protected | specialist | Internal administrative information or dedicated owner workflow; not an employee input. |
