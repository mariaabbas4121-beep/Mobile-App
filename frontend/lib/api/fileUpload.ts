import { Platform } from 'react-native';
import { File, UploadType } from 'expo-file-system';
import { UploadTimeoutError, type FileUploader } from './client';

// Android and iOS: the native uploader reads the picked file from disk and
// sends its bytes as the request body. Building a JS Blob from the file and
// passing it to fetch is unreliable in React Native (the body can arrive
// empty or not at all), so it is not used on devices.
export const nativeFileUpload: FileUploader = async (url, fileUri, { headers, contentType, timeoutMs }) => {
  const task = new File(fileUri).createUploadTask(url, {
    httpMethod: 'POST',
    uploadType: UploadType.BINARY_CONTENT,
    headers,
    mimeType: contentType,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      task.cancel();
      reject(new UploadTimeoutError());
    }, timeoutMs);
  });
  try {
    return await Promise.race([task.uploadAsync(), timeout]);
  } finally {
    clearTimeout(timer);
  }
};

// Expo web: the picker returns a blob: URL, which browsers upload reliably.
export const webFileUpload: FileUploader = async (url, fileUri, { headers, timeoutMs }) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const blob = await (await fetch(fileUri)).blob();
    const response = await fetch(url, { method: 'POST', headers, body: blob, signal: controller.signal });
    const out: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      out[key] = value;
    });
    return { status: response.status, body: await response.text(), headers: out };
  } catch (err) {
    if (controller.signal.aborted) throw new UploadTimeoutError();
    throw err;
  } finally {
    clearTimeout(timer);
  }
};

export const fileUpload: FileUploader = Platform.OS === 'web' ? webFileUpload : nativeFileUpload;
