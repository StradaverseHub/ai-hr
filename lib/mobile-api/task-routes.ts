/** Request parsing shared by the M08 v2 task routes (app/api/mobile/v2/tasks/**). Server only. */
import { MobileBadRequest } from './handler';
import { isNativeTaskKind, type NativeTaskKind } from './v2/tasks';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The `{kind}/{id}` after `/tasks/`: a natively decided kind and a UUID, or a 400 (the app never asks for another). */
export function taskOf(req: Request): { kind: NativeTaskKind; id: string } {
  const parts = new URL(req.url).pathname.split('/');
  const at = parts.indexOf('tasks');
  const kind = parts[at + 1] ?? '', id = parts[at + 2] ?? '';
  if (at < 0 || !isNativeTaskKind(kind) || !UUID.test(id)) throw new MobileBadRequest('Invalid task reference');
  return { kind, id: id.toLowerCase() };
}
