// Sharing a pickup QR with the person who will collect the item. They need
// no account: they only show the QR (or read out the code) to the owner.
// The QR is shared as an image through the native share sheet; where that is
// not possible, the code is shared as text instead.

export interface PickupShare {
  // Collecting the item, or bringing it back. Defaults to pickup.
  operation?: 'pickup' | 'return';
  // PNG of the QR, base64 (react-native-qrcode-svg's toDataURL), if available.
  qrPngBase64: string | null;
  recipientName: string;
  itemTitle: string;
  displayCode: string;
  expiresAt: string;
}

export const pickupShareMessage = (s: PickupShare) =>
  `Hi ${s.recipientName}, please ${s.operation === 'return' ? 'return' : 'collect'} "${s.itemTitle}" for me on NeighborShare. ` +
  `Show this QR to the owner, or read them this code: ${s.displayCode}. ` +
  `It works once and expires ${new Date(s.expiresAt).toLocaleString()}.`;

export async function sharePickupQr(s: PickupShare): Promise<'image' | 'text'> {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { Share } = require('react-native') as typeof import('react-native');
  if (s.qrPngBase64) {
    try {
      const Sharing = require('expo-sharing') as typeof import('expo-sharing');
      const { File, Paths } = require('expo-file-system') as typeof import('expo-file-system');
      if (await Sharing.isAvailableAsync()) {
        // App cache only; the system may clear it.
        const file = new File(Paths.cache, 'neighborshare-pickup-qr.png');
        if (file.exists) file.delete();
        file.create();
        await file.write(s.qrPngBase64, { encoding: 'base64' });
        await Sharing.shareAsync(file.uri, {
          mimeType: 'image/png',
          dialogTitle: `${s.operation === 'return' ? 'Return' : 'Pickup'} QR for ${s.recipientName}`,
          UTI: 'public.png',
        });
        return 'image';
      }
    } catch {
      // Fall through to text.
    }
  }
  /* eslint-enable @typescript-eslint/no-require-imports */
  await Share.share({ message: pickupShareMessage(s) });
  return 'text';
}
