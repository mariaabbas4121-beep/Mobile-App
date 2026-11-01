// The device uploader must send the picked file itself as the raw body
// (BINARY_CONTENT, POST, with the API headers), never a JS Blob, and must
// cancel the native task when it times out.
const mockTask = { uploadAsync: jest.fn(), cancel: jest.fn() };
const mockCreateUploadTask = jest.fn((..._args: unknown[]) => mockTask);
const mockFileUris: string[] = [];

jest.mock('expo-file-system', () => ({
  UploadType: { BINARY_CONTENT: 0, MULTIPART: 1 },
  File: jest.fn().mockImplementation((uri: string) => {
    mockFileUris.push(uri);
    return { createUploadTask: mockCreateUploadTask };
  }),
}));

import { nativeFileUpload } from '../lib/api/fileUpload';
import { UploadTimeoutError } from '../lib/api/client';

beforeEach(() => {
  jest.clearAllMocks();
  mockFileUris.length = 0;
});

const init = {
  headers: { Accept: 'application/json', 'Content-Type': 'image/jpeg', Authorization: 'Bearer tok' },
  contentType: 'image/jpeg',
  timeoutMs: 1000,
};

test('uploads the local file as the raw POST body with the API headers', async () => {
  mockTask.uploadAsync.mockResolvedValue({ status: 201, body: '{"success":true}', headers: {} });
  const result = await nativeFileUpload('http://api.test/api/v1/items/a/images', 'file:///data/photo.jpg', init);

  expect(mockFileUris).toEqual(['file:///data/photo.jpg']);
  expect(mockCreateUploadTask).toHaveBeenCalledWith('http://api.test/api/v1/items/a/images', {
    httpMethod: 'POST',
    uploadType: 0,
    headers: init.headers,
    mimeType: 'image/jpeg',
  });
  expect(result.status).toBe(201);
  expect(mockTask.cancel).not.toHaveBeenCalled();
});

test('cancels the native task and rejects with UploadTimeoutError when it takes too long', async () => {
  jest.useFakeTimers();
  try {
    mockTask.uploadAsync.mockReturnValue(new Promise(() => undefined));
    const pending = nativeFileUpload('http://api.test/x', 'file:///p.jpg', init);
    jest.advanceTimersByTime(1001);
    await expect(pending).rejects.toBeInstanceOf(UploadTimeoutError);
    expect(mockTask.cancel).toHaveBeenCalledTimes(1);
  } finally {
    jest.useRealTimers();
  }
});

test('passes through a network failure', async () => {
  mockTask.uploadAsync.mockRejectedValue(new Error('connection reset'));
  await expect(nativeFileUpload('http://api.test/x', 'file:///p.jpg', init)).rejects.toThrow('connection reset');
});
