import type { ImageUploadType } from '../api/types';
import { MAX_PHOTO_BYTES } from './options';

// A photo chosen on the device, not yet uploaded.
export interface LocalPhoto {
  uri: string;
  type: ImageUploadType;
  size: number | null;
}

const EXTENSION_TYPES: Record<string, ImageUploadType> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

// The upload type of an image-picker asset, or null for formats the server
// refuses (e.g. HEIC, GIF). The server checks the file's bytes as well.
export function photoType(asset: { uri: string; mimeType?: string | null; fileName?: string | null }): ImageUploadType | null {
  const mime = asset.mimeType?.toLowerCase();
  if (mime === 'image/jpeg' || mime === 'image/jpg') return 'image/jpeg';
  if (mime === 'image/png' || mime === 'image/webp') return mime;
  if (mime) return null;
  const name = (asset.fileName ?? asset.uri).split('?')[0] ?? '';
  return EXTENSION_TYPES[name.split('.').pop()?.toLowerCase() ?? ''] ?? null;
}

export type PhotoProblem = 'unsupported' | 'too_large';

export function toLocalPhoto(asset: {
  uri: string;
  mimeType?: string | null;
  fileName?: string | null;
  fileSize?: number | null;
}): LocalPhoto | PhotoProblem {
  const type = photoType(asset);
  if (!type) return 'unsupported';
  if (asset.fileSize && asset.fileSize > MAX_PHOTO_BYTES) return 'too_large';
  return { uri: asset.uri, type, size: asset.fileSize ?? null };
}
