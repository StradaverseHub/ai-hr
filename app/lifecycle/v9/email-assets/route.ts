import { requireModule } from '@/lib/authz';
import { v9UploadEmailAsset } from '@/packs/lifecycle/service';
import { noticeUploadSameOrigin, readNoticeUploadRequest, NoticeUploadRequestError } from '@/lib/notice-upload-request';
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
const response = (body: unknown, status: number) => Response.json(body, { status, headers });
export async function POST(request: Request) {
  if (!noticeUploadSameOrigin(request)) return response({ error: 'Upload unavailable.' }, 403);
  try {
    const session = await requireModule('lifecycle'), data = await readNoticeUploadRequest(request, 10 * 1048576);
    const one = (name: string) => { const values = data.getAll(name); return values.length === 1 ? values[0] : null; };
    const file = one('file'), emailId = one('emailId'), kind = one('kind'), revision = one('revision');
    if (!(file instanceof File) || typeof emailId !== 'string' || !['file','image'].includes(String(kind)) || typeof revision !== 'string' || !/^[1-9]\d*$/.test(revision)) return response({ error: 'Choose a file and email template.' }, 400);
    const asset = await v9UploadEmailAsset(session, { emailId, kind: kind as 'file' | 'image', revision: Number(revision), name: file.name, content: Buffer.from(await file.arrayBuffer()) });
    return response({ asset }, 201);
  } catch (error) {
    if (error instanceof NoticeUploadRequestError) return response({ error: error.reason === 'tooLarge' ? 'Files can be up to 10 MB; email images can be up to 1 MB.' : 'Invalid upload.' }, error.status);
    return response({ error: error instanceof Error && error.name === 'V9Error' ? error.message : 'The email file could not be uploaded. Refresh and try again.' }, 409);
  }
}
