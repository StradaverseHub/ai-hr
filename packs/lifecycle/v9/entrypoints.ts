/** Lazy facade: existing Node lifecycle consumers do not load framework-only V9 code.
 * The literal dynamic import keeps Next's server-only boundary in the browser build graph.
 * Standalone V9 maintenance entry points use Node's official react-server condition.
 */
type Service = typeof import('./service');
async function load(): Promise<Service> {
  const loaded = await import('./service');
  return (loaded as { default?: Service }).default ?? loaded;
}
export const v9Workspace: Service['v9Workspace'] = async (...args) => (await load()).v9Workspace(...args);
export const v9Setup: Service['v9Setup'] = async (...args) => (await load()).v9Setup(...args);
export const v9SaveConfig: Service['v9SaveConfig'] = async (...args) => (await load()).v9SaveConfig(...args);
export const v9CreateOffboarding: Service['v9CreateOffboarding'] = async (...args) => (await load()).v9CreateOffboarding(...args);
export const v9Command: Service['v9Command'] = async (...args) => (await load()).v9Command(...args);
export const v9OwnWork: Service['v9OwnWork'] = async (...args) => (await load()).v9OwnWork(...args);
export const v9OwnDocument: Service['v9OwnDocument'] = async (...args) => (await load()).v9OwnDocument(...args);
export const v9CaseDetail: Service['v9CaseDetail'] = async (...args) => (await load()).v9CaseDetail(...args);
export const v9Sweep: Service['v9Sweep'] = async (...args) => (await load()).v9Sweep(...args);
export const v9OwnTask: Service['v9OwnTask'] = async (...args) => (await load()).v9OwnTask(...args);
export const v9UploadFile: Service['v9UploadFile'] = async (...args) => (await load()).v9UploadFile(...args);
export const v9DownloadFile: Service['v9DownloadFile'] = async (...args) => (await load()).v9DownloadFile(...args);

export const v9PreviewEmail: Service['v9PreviewEmail'] = async (...args) => (await load()).v9PreviewEmail(...args);

export const v9DownloadDocument: Service['v9DownloadDocument'] = async (...args) => (await load()).v9DownloadDocument(...args);

export const v9DeliverEmails: Service['v9DeliverEmails'] = async (...args) => (await load()).v9DeliverEmails(...args);

export const v9UploadEmailAsset: Service['v9UploadEmailAsset'] = async (...args) => (await load()).v9UploadEmailAsset(...args);
export const v9DownloadEmailAsset: Service['v9DownloadEmailAsset'] = async (...args) => (await load()).v9DownloadEmailAsset(...args);

export const v9ReportOwnReturn: Service['v9ReportOwnReturn'] = async (...args) => (await load()).v9ReportOwnReturn(...args);

export const v9OwnEquipmentReceipt: Service['v9OwnEquipmentReceipt'] = async (...args) => (await load()).v9OwnEquipmentReceipt(...args);

export const v9PreviewUpdatedEmail: Service['v9PreviewUpdatedEmail'] = async (...args) => (await load()).v9PreviewUpdatedEmail(...args);

export const v9OwnItem: Service['v9OwnItem'] = async (...args) => (await load()).v9OwnItem(...args);

export const v9PreviewWorkflow: Service['v9PreviewWorkflow'] = async (...args) => (await load()).v9PreviewWorkflow(...args);
