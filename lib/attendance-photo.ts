import sharp from 'sharp';
import { createHash } from 'node:crypto';
export const CLOCK_PHOTO_MAX_BYTES = 2 * 1024 * 1024;
export async function decodeClockPhoto(bytes: Buffer, mime: string) {
  if (!bytes.length || bytes.length > CLOCK_PHOTO_MAX_BYTES || !['image/jpeg', 'image/png'].includes(mime)) throw new Error('Use a JPEG or PNG photo no larger than 2 MB');
  const image = sharp(bytes, { limitInputPixels: 16_777_216, failOn: 'warning' });
  const metadata = await image.metadata();
  if (!['jpeg', 'png'].includes(metadata.format ?? '') || (metadata.format === 'jpeg' ? 'image/jpeg' : 'image/png') !== mime || !metadata.width || !metadata.height || metadata.width > 4096 || metadata.height > 4096 || (metadata.pages ?? 1) !== 1) throw new Error('Invalid clock photo');
  const full = await image.rotate().resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer({ resolveWithObject: true });
  const thumb = await sharp(full.data).resize(96, 96, { fit: 'cover' }).jpeg({ quality: 75 }).toBuffer();
  return { photoBytes: full.data, thumbnailBytes: thumb, decodedWidth: full.info.width, decodedHeight: full.info.height, photoSize: full.data.length, photoDigest: createHash('sha256').update(bytes).digest('hex') };
}
