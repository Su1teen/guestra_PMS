import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';

export const PRIVATE_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
export type PrivatePhoto = {
  id: string;
  storageKey: string;
  name: string;
  contentType: string;
  size: number;
  sha256: string;
};
export function privatePhotoIdentity(
  propertyId: string,
  ownerId: string,
  key: string,
  kind: string,
) {
  if (typeof key !== 'string' || !key.trim() || key.length > 200)
    throw new BadRequestException('Укажите ключ загрузки.');
  const token = createHash('sha256')
    .update(propertyId + ':' + kind + ':' + ownerId + ':' + key)
    .digest('hex');
  const id =
    token.slice(0, 8) +
    '-' +
    token.slice(8, 12) +
    '-4' +
    token.slice(13, 16) +
    '-8' +
    token.slice(17, 20) +
    '-' +
    token.slice(20, 32);
  return {
    id,
    storageKey: `properties/${propertyId}/private/${kind}/${ownerId}/${token}`,
  };
}
/** Signature and exact MIME agreement; active formats and arbitrary URL ingestion are excluded. */
export function privatePhoto(
  buffer: Buffer,
  declaredType: string,
  filename: string,
  propertyId: string,
  ownerId: string,
  key: string,
  kind = 'maintenance',
): PrivatePhoto {
  if (!buffer?.length || buffer.length > PRIVATE_PHOTO_MAX_BYTES)
    throw new BadRequestException(
      'Фотография должна быть размером от 1 байта до 10 МБ.',
    );
  let type: string | undefined;
  if (
    buffer.length >= 24 &&
    buffer
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    buffer.subarray(12, 16).toString() === 'IHDR'
  )
    type = 'image/png';
  if (
    buffer.length >= 12 &&
    buffer[0] === 255 &&
    buffer[1] === 216 &&
    buffer[2] === 255 &&
    buffer[buffer.length - 2] === 255 &&
    buffer[buffer.length - 1] === 217
  )
    type = 'image/jpeg';
  if (
    buffer.length >= 20 &&
    buffer.subarray(0, 4).toString() === 'RIFF' &&
    buffer.subarray(8, 12).toString() === 'WEBP' &&
    buffer.readUInt32LE(4) + 8 === buffer.length
  )
    type = 'image/webp';
  if (!type || type !== declaredType)
    throw new BadRequestException(
      'Разрешены фотографии JPEG, PNG и WebP с соответствующим содержимым файла.',
    );
  return {
    ...privatePhotoIdentity(propertyId, ownerId, key, kind),
    name: ((typeof filename === 'string' && filename) || 'Фото')
      .replace(/[\r\n/\\]/g, '_')
      .slice(0, 255),
    contentType: type,
    size: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  };
}
