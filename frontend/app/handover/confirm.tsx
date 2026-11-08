import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Linking, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import { useBorrowRequests, type EvidenceResult } from '../../context/BorrowRequestsContext';
import { useChat } from '../../context/ChatContext';
import { isApiError } from '../../lib/api/client';
import type { BorrowRequest, Handover, PickupAuthorization } from '../../lib/api/types';
import { errorMessage } from '../../lib/auth/messages';
import { formatRange } from '../../lib/borrow/dates';
import { when } from '../../lib/handover/format';
import { codeFromScan } from '../../lib/handover/pickupCode';
import { toLocalPhoto, type LocalPhoto } from '../../lib/listings/photos';
import { Colors, Radii, Shadows, Spacing, Typography } from '../../utils/theme';

const GREEN = Colors.green || '#2e7d32';
const DARK = Colors.greenDark || '#1b5e20';
const MAX_EVIDENCE_PHOTOS = 5;

type Step =
  | { kind: 'loading' }
  | { kind: 'scan'; problem: string | null; checking: boolean }
  | { kind: 'review'; authorization: PickupAuthorization | null; code: string | null }
  | { kind: 'done'; handover: Handover; evidence: EvidenceResult | null }
  | { kind: 'error'; error: unknown };

// Codes whose screens say "do not hand over".
const STOP_CODES = new Set(['AUTHORIZATION_REVOKED', 'AUTHORIZATION_EXPIRED', 'AUTHORIZATION_ALREADY_USED', 'INVALID_PICKUP_CODE']);

// Lender: confirm the handover. mode=scan: scan (or type) the authorized
// person's code first; mode=personal: the borrower collects in person.
// Scanning only checks the code; nothing is recorded until "Confirm handover".
export default function ConfirmHandoverScreen() {
  const router = useRouter();
  const { requestId, mode } = useLocalSearchParams<{ requestId: string; mode: 'scan' | 'personal' }>();
  const { get, verifyPickupCode, confirmHandover, uploadEvidence } = useBorrowRequests();
  const { handoverChanged } = useChat();
  const [permission, requestPermission] = useCameraPermissions();
  const [request, setRequest] = useState<BorrowRequest | null>(null);
  const [step, setStep] = useState<Step>({ kind: 'loading' });
  const [typed, setTyped] = useState('');
  const [itemChecked, setItemChecked] = useState(false);
  const [personChecked, setPersonChecked] = useState(false);
  const [notes, setNotes] = useState('');
  const [photos, setPhotos] = useState<LocalPhoto[]>([]);
  const [photoNote, setPhotoNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  // One scan at a time: the camera reports the same QR many times a second.
  const scanning = useRef(false);

  useEffect(() => {
    void (async () => {
      try {
        const r = await get(requestId);
        setRequest(r);
        setStep(mode === 'personal' ? { kind: 'review', authorization: null, code: null } : { kind: 'scan', problem: null, checking: false });
      } catch (err) {
        setStep({ kind: 'error', error: err });
      }
    })();
  }, [get, requestId, mode]);

  const check = useCallback(
    async (raw: string) => {
      if (scanning.current) return;
      const code = codeFromScan(raw);
      if (!code) {
        setStep({ kind: 'scan', problem: 'This is not a NeighborShare pickup QR.', checking: false });
        return;
      }
      scanning.current = true;
      setStep({ kind: 'scan', problem: null, checking: true });
      try {
        const authorization = await verifyPickupCode(requestId, code);
        setStep({ kind: 'review', authorization, code });
      } catch (err) {
        const stop = isApiError(err) && STOP_CODES.has(err.code);
        setStep({ kind: 'scan', problem: `${stop ? 'Do not hand over the item. ' : ''}${errorMessage(err)}`, checking: false });
      } finally {
        scanning.current = false;
      }
    },
    [verifyPickupCode, requestId],
  );

  const addPhotos = async (source: 'camera' | 'library') => {
    setPhotoNote(null);
    try {
      if (source === 'camera') {
        const p = await ImagePicker.requestCameraPermissionsAsync();
        if (!p.granted) {
          setPhotoNote('Camera access is off. Choose photos from the library, or allow the camera in Settings.');
          return;
        }
      }
      const options: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 0.7, allowsMultipleSelection: source === 'library' };
      const result = source === 'camera' ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
      if (result.canceled) return;
      const next: LocalPhoto[] = [];
      let skipped = 0;
      for (const asset of result.assets) {
        const photo = toLocalPhoto(asset);
        if (typeof photo === 'string') skipped += 1;
        else next.push(photo);
      }
      const room = MAX_EVIDENCE_PHOTOS - photos.length;
      if (next.length > room) setPhotoNote(`At most ${MAX_EVIDENCE_PHOTOS} photos; the rest were left out.`);
      else if (skipped > 0) setPhotoNote(`${skipped} photo(s) were left out: use JPEG, PNG or WebP under 5 MB.`);
      setPhotos((p) => [...p, ...next.slice(0, room)]);
    } catch {
      setPhotoNote('Could not open the camera or photo library.');
    }
  };

  const confirm = async (authorization: PickupAuthorization | null, code: string | null) => {
    setBusy(true);
    setConfirmError(null);
    try {
      const handover = await confirmHandover(
        requestId,
        code ? { method: 'authorized', code, conditionNotes: notes.trim() || null } : { method: 'personal', conditionNotes: notes.trim() || null },
      );
      handoverChanged();
      // Recorded. Photos follow; failures are reported, never hidden.
      const evidence = photos.length > 0 ? await uploadEvidence(requestId, photos) : null;
      setStep({ kind: 'done', handover, evidence });
    } catch (err) {
      if (authorization && isApiError(err) && STOP_CODES.has(err.code)) {
        setStep({ kind: 'scan', problem: `Do not hand over the item. ${errorMessage(err)}`, checking: false });
      } else {
        setConfirmError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const retryPhotos = async (failed: LocalPhoto[], handover: Handover) => {
    setBusy(true);
    const evidence = await uploadEvidence(requestId, failed);
    setStep((s) =>
      s.kind === 'done' && s.evidence
        ? { kind: 'done', handover, evidence: { saved: [...s.evidence.saved, ...evidence.saved], failed: evidence.failed, firstError: evidence.firstError } }
        : s,
    );
    setBusy(false);
  };

  const borrower = request?.borrower.displayName ?? 'the borrower';

  const header = (
    <View style={styles.header}>
      <SafeAreaView edges={['top']}>
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} accessibilityRole="button" accessibilityLabel="Close">
            <Ionicons name="close" size={20} color={Colors.navy} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{mode === 'personal' ? 'Confirm pickup' : 'Scan pickup QR'}</Text>
          <View style={{ width: 40 }} />
        </View>
      </SafeAreaView>
    </View>
  );

  let content: React.ReactNode = null;
  if (step.kind === 'loading') {
    content = <ActivityIndicator size="large" color={GREEN} style={{ marginTop: 60 }} accessibilityLabel="Loading" />;
  } else if (step.kind === 'error') {
    content = (
      <View style={styles.card}>
        <Text style={styles.title}>Could not load this request</Text>
        <Text style={styles.meta}>{errorMessage(step.error)}</Text>
      </View>
    );
  } else if (step.kind === 'scan') {
    content = (
      <View style={styles.card}>
        <Text style={styles.meta}>Ask the person collecting {request?.listing.title} to show their QR.</Text>
        {!permission ? (
          <ActivityIndicator color={GREEN} accessibilityLabel="Checking camera permission" />
        ) : permission.granted ? (
          <View style={styles.cameraBox}>
            <CameraView
              testID="pickup-scanner"
              style={StyleSheet.absoluteFill}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={step.checking ? undefined : ({ data }) => void check(data)}
            />
            {step.checking ? (
              <View style={styles.cameraOverlay}>
                <ActivityIndicator color={Colors.white} accessibilityLabel="Checking code" />
              </View>
            ) : null}
          </View>
        ) : (
          <View style={styles.permission} accessibilityLabel="Camera permission needed">
            <Text style={styles.body1}>Camera access is needed to scan the QR.</Text>
            {permission.canAskAgain ? (
              <TouchableOpacity style={styles.primaryBtn} onPress={() => void requestPermission()} accessibilityRole="button" accessibilityLabel="Allow camera">
                <Text style={styles.primaryText}>Allow camera</Text>
              </TouchableOpacity>
            ) : (
              <>
                <Text style={styles.meta}>Camera access is turned off for NeighborShare. Turn it on in Settings, or type the code below.</Text>
                <TouchableOpacity style={styles.secondaryBtn} onPress={() => void Linking.openSettings()} accessibilityRole="button" accessibilityLabel="Open Settings">
                  <Text style={styles.secondaryText}>Open Settings</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        )}
        {step.problem ? (
          <Text style={styles.stop} accessibilityRole="alert">
            {step.problem}
          </Text>
        ) : null}
        <Text style={styles.label}>Or type the code</Text>
        <TextInput
          style={styles.input}
          value={typed}
          onChangeText={setTyped}
          placeholder="XXXX-XXXX-XXXX-…"
          autoCapitalize="characters"
          autoCorrect={false}
          accessibilityLabel="Pickup code"
        />
        <TouchableOpacity
          style={[styles.secondaryBtn, (step.checking || !typed.trim()) && styles.disabled]}
          disabled={step.checking || !typed.trim()}
          onPress={() => void check(typed)}
          accessibilityRole="button"
          accessibilityLabel="Check code"
        >
          <Text style={styles.secondaryText}>Check code</Text>
        </TouchableOpacity>
      </View>
    );
  } else if (step.kind === 'review') {
    const { authorization, code } = step;
    const ready = itemChecked && (!authorization || personChecked);
    content = (
      <View style={styles.card}>
        {authorization ? (
          <View style={styles.okBox} accessibilityLabel="Valid pickup code">
            <Ionicons name="shield-checkmark" size={20} color={DARK} />
            <View style={{ flex: 1 }}>
              <Text style={styles.body1}>Valid code: {borrower} authorized</Text>
              <Text style={styles.recipient}>{authorization.recipientName}</Text>
              {authorization.recipientPhone ? <Text style={styles.meta}>Phone: {authorization.recipientPhone}</Text> : null}
              {authorization.note ? <Text style={styles.meta}>Note: {authorization.note}</Text> : null}
              <Text style={styles.small}>Valid until {when(authorization.expiresAt)}</Text>
            </View>
          </View>
        ) : (
          <Text style={styles.meta}>{borrower} is collecting the item in person.</Text>
        )}
        <Text style={styles.label}>Item</Text>
        <Text style={styles.body1}>{request?.listing.title}</Text>
        {request ? <Text style={styles.meta}>{formatRange(request.startDate, request.endDate)}</Text> : null}

        <Text style={styles.label}>Before you hand it over</Text>
        {authorization ? (
          <Check
            checked={personChecked}
            onToggle={() => setPersonChecked((v) => !v)}
            label={`The person is ${authorization.recipientName}`}
          />
        ) : null}
        <Check checked={itemChecked} onToggle={() => setItemChecked((v) => !v)} label="I checked the item and its condition" />

        <Text style={styles.label}>Condition notes (optional)</Text>
        <TextInput
          style={[styles.input, { minHeight: 70 }]}
          value={notes}
          onChangeText={setNotes}
          placeholder="e.g. Small scratch on the handle"
          maxLength={1000}
          multiline
          accessibilityLabel="Condition notes"
        />
        <Text style={styles.label}>Condition photos (optional, up to {MAX_EVIDENCE_PHOTOS})</Text>
        <View style={styles.photos}>
          {photos.map((p, i) => (
            <TouchableOpacity key={p.uri} onPress={() => setPhotos((all) => all.filter((_, j) => j !== i))} accessibilityRole="button" accessibilityLabel={`Remove photo ${i + 1}`}>
              <Image source={{ uri: p.uri }} style={styles.photo} />
            </TouchableOpacity>
          ))}
        </View>
        {photos.length < MAX_EVIDENCE_PHOTOS ? (
          <View style={styles.row}>
            <TouchableOpacity style={styles.smallBtn} onPress={() => void addPhotos('camera')} accessibilityRole="button" accessibilityLabel="Take a photo">
              <Ionicons name="camera-outline" size={16} color={DARK} />
              <Text style={styles.secondaryText}>Take photo</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.smallBtn} onPress={() => void addPhotos('library')} accessibilityRole="button" accessibilityLabel="Choose photos">
              <Ionicons name="images-outline" size={16} color={DARK} />
              <Text style={styles.secondaryText}>Choose</Text>
            </TouchableOpacity>
          </View>
        ) : null}
        {photoNote ? <Text style={styles.small}>{photoNote}</Text> : null}
        <Text style={styles.small}>Photos are private: only you and {borrower} can see them.</Text>

        {confirmError ? (
          <Text style={styles.stop} accessibilityRole="alert">
            {confirmError}
          </Text>
        ) : null}
        <TouchableOpacity
          style={[styles.primaryBtn, (!ready || busy) && styles.disabled]}
          disabled={!ready || busy}
          onPress={() => void confirm(authorization, code)}
          accessibilityRole="button"
          accessibilityLabel="Confirm handover"
          accessibilityState={{ disabled: !ready || busy }}
        >
          {busy ? <ActivityIndicator size="small" color={Colors.white} /> : null}
          <Text style={styles.primaryText}>Confirm handover</Text>
        </TouchableOpacity>
        <Text style={styles.small}>This records that you handed the item over now. It cannot be undone.</Text>
      </View>
    );
  } else {
    const { handover, evidence } = step;
    content = (
      <View style={styles.card} accessibilityLabel="Handover recorded">
        <Ionicons name="checkmark-circle" size={44} color={GREEN} style={{ alignSelf: 'center' }} />
        <Text style={[styles.title, { textAlign: 'center' }]}>Handover recorded</Text>
        <Text style={[styles.meta, { textAlign: 'center' }]}>
          {handover.method === 'authorized' ? `Handed to ${handover.recipientName}` : `Handed to ${borrower}`} · {when(handover.confirmedAt)}
        </Text>
        {evidence ? (
          evidence.failed.length === 0 ? (
            <Text style={styles.meta}>
              {evidence.saved.length} condition photo{evidence.saved.length === 1 ? '' : 's'} saved.
            </Text>
          ) : (
            <View style={styles.warnBox} accessibilityRole="alert">
              <Text style={styles.body1}>
                {evidence.saved.length} of {evidence.saved.length + evidence.failed.length} photos saved. {evidence.failed.length} could not be uploaded.
              </Text>
              <Text style={styles.meta}>{errorMessage(evidence.firstError)} The handover itself is recorded.</Text>
              <TouchableOpacity
                style={[styles.secondaryBtn, busy && styles.disabled]}
                disabled={busy}
                onPress={() => void retryPhotos(evidence.failed, handover)}
                accessibilityRole="button"
                accessibilityLabel="Retry photo upload"
              >
                <Text style={styles.secondaryText}>Retry upload</Text>
              </TouchableOpacity>
            </View>
          )
        ) : null}
        <TouchableOpacity style={styles.primaryBtn} onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Done">
          <Text style={styles.primaryText}>Done</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {header}
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {content}
      </ScrollView>
    </View>
  );
}

function Check({ checked, onToggle, label }: { checked: boolean; onToggle: () => void; label: string }) {
  return (
    <TouchableOpacity style={styles.check} onPress={onToggle} accessibilityRole="checkbox" accessibilityLabel={label} accessibilityState={{ checked }}>
      <Ionicons name={checked ? 'checkbox' : 'square-outline'} size={22} color={checked ? GREEN : Colors.slate} />
      <Text style={styles.body1}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.offWhite },
  header: { backgroundColor: Colors.white, paddingHorizontal: Spacing.xl, paddingBottom: Spacing.md, borderBottomWidth: 1, borderColor: Colors.fog, ...Shadows.sm },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: Spacing.sm },
  backBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: Colors.fog, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: Typography.sizes.md, fontWeight: Typography.weights.bold, color: Colors.navy },
  body: { padding: Spacing.xl, paddingBottom: 60 },
  card: { backgroundColor: Colors.white, borderRadius: Radii.lg, padding: Spacing.lg, gap: Spacing.sm, borderWidth: 1, borderColor: Colors.fog, ...Shadows.sm },
  title: { fontSize: Typography.sizes.lg, fontWeight: Typography.weights.bold, color: DARK },
  body1: { flexShrink: 1, fontSize: Typography.sizes.base, color: Colors.navy, fontWeight: Typography.weights.semibold },
  recipient: { fontSize: Typography.sizes.xl, fontWeight: Typography.weights.extrabold, color: DARK },
  label: { fontSize: Typography.sizes.sm, fontWeight: Typography.weights.bold, color: Colors.navy, marginTop: Spacing.sm },
  meta: { fontSize: Typography.sizes.sm, color: Colors.slate },
  small: { fontSize: Typography.sizes.xs, color: Colors.slate },
  stop: { fontSize: Typography.sizes.sm, color: '#b91c1c', fontWeight: Typography.weights.semibold, backgroundColor: '#fee2e2', borderRadius: Radii.md, padding: Spacing.md },
  okBox: { flexDirection: 'row', gap: Spacing.sm, backgroundColor: '#e8f5e9', borderRadius: Radii.md, padding: Spacing.md },
  warnBox: { backgroundColor: '#fef3c7', borderRadius: Radii.md, padding: Spacing.md, gap: Spacing.xs },
  cameraBox: { height: 260, borderRadius: Radii.lg, overflow: 'hidden', backgroundColor: '#000' },
  cameraOverlay: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center' },
  permission: { gap: Spacing.sm, padding: Spacing.md, borderRadius: Radii.md, backgroundColor: Colors.offWhite },
  input: {
    borderWidth: 1, borderColor: Colors.fog, borderRadius: Radii.md, paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    fontSize: Typography.sizes.base, color: Colors.navy, backgroundColor: Colors.offWhite,
  },
  check: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, paddingVertical: 4 },
  row: { flexDirection: 'row', gap: Spacing.sm },
  photos: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  photo: { width: 64, height: 64, borderRadius: Radii.md },
  primaryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: GREEN, borderRadius: Radii.full,
    paddingVertical: Spacing.sm + 2, paddingHorizontal: Spacing.lg, marginTop: Spacing.sm,
  },
  primaryText: { color: Colors.white, fontWeight: Typography.weights.bold, fontSize: Typography.sizes.sm },
  secondaryBtn: { alignItems: 'center', borderWidth: 1, borderColor: GREEN, borderRadius: Radii.full, paddingVertical: Spacing.sm, paddingHorizontal: Spacing.lg },
  secondaryText: { color: DARK, fontWeight: Typography.weights.bold, fontSize: Typography.sizes.sm },
  smallBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderColor: GREEN, borderRadius: Radii.full, paddingVertical: 6, paddingHorizontal: Spacing.md },
  disabled: { opacity: 0.5 },
});
