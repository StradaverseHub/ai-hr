/** 96a54ed2 — the hrefs the Attendance pack offers in the admin Attendance node and as Manage rows. */
import { attendancePack } from '../../packs/attendance';

const nodes = (attendancePack.navNodes ?? []) as { group?: string; children?: { href: string }[] }[];
const links = (attendancePack.navLinks ?? []) as { href: string; group?: string }[];
export const ATTENDANCE_NAV_FOR_TEST = {
  admin: nodes.filter(node => node.group === 'admin').flatMap(node => (node.children ?? []).map(child => child.href)),
  manage: links.filter(link => link.group === 'manage').map(link => link.href),
};
