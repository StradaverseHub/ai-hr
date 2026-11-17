'use client';
import {BoundedEmploymentPicker,type BoundedEmploymentPickerProps} from './bounded-employment-picker';
export type WorkforcePickerProps=Omit<BoundedEmploymentPickerProps,'endpoint'>;
/** Native Workforce authorization is owned by this endpoint, independently of other picker populations. */
export function WorkforcePicker(props:WorkforcePickerProps){return <BoundedEmploymentPicker {...props} endpoint="/api/workforce-choices"/>;}
