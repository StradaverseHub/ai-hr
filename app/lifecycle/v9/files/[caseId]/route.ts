import { requireModule } from '@/lib/authz';
import { v9CaseDetail, v9UploadFile, v9DownloadFile } from '@/packs/lifecycle/service';
import { noticeUploadSameOrigin, readNoticeUploadRequest, NoticeUploadRequestError } from '@/lib/notice-upload-request';
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
const response = (body: unknown, status: number) => Response.json(body, { status, headers });
export async function POST(request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  if (!noticeUploadSameOrigin(request)) return response({ error: 'Upload unavailable.' }, 403);
  try {
    const session = await requireModule('lifecycle'), { caseId } = await params;
    await v9CaseDetail(session, caseId);
    const data = await readNoticeUploadRequest(request, 10 * 1024 * 1024);
    const one = (name: string) => { const values = data.getAll(name); return values.length === 1 ? values[0] : null; };
    const file = one('file'), slot = one('slot'), revision = one('revision');
    if (!(file instanceof File) || typeof slot !== 'string' || typeof revision !== 'string' || !/^[1-9]\d*$/.test(revision)) return response({ error: 'Choose a file and attachment slot.' }, 400);
    const id = await v9UploadFile(session, { caseId, revision: Number(revision), slot, name: file.name, content: Buffer.from(await file.arrayBuffer()) });
    return response({ id }, 201);
  } catch (error) {
    if (error instanceof NoticeUploadRequestError) return response({ error: error.reason === 'tooLarge' ? 'Choose a file of at most 10 MB.' : 'Invalid upload.' }, error.status);
    return response({ error: 'The file could not be uploaded. Check the file type and refresh the case.' }, 409);
  }
}
export async function GET(request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  try {
    const session = await requireModule('lifecycle'), { caseId } = await params, fileId = new URL(request.url).searchParams.get('file') ?? '';
    const file = await v9DownloadFile(session, caseId, fileId);
    return new Response(new Uint8Array(file.content), { headers: { ...headers, 'Content-Type': file.mimeType, 'Content-Disposition': `attachment; filename="document"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g, character => '%' + character.charCodeAt(0).toString(16))}` } });
  } catch { return response({ error: 'File not found or unavailable.' }, 404); }
}
