import { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  TextInput, KeyboardAvoidingView, Platform, Image, ActivityIndicator,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import Toast from 'react-native-toast-message';
import * as ImagePicker from 'expo-image-picker';
import { useAuth } from '../../context/AuthContext';
import { useListings, type LocationChange, type SaveResult } from '../../context/ListingsContext';
import { useDiscovery } from '../../context/DiscoveryContext';
import { SpotPicker } from '../../components/discovery/SpotPicker';
import { CITIES, cityNamed } from '../../lib/location/places';
import { useSubmit } from '../../components/auth/useSubmit';
import { isApiError } from '../../lib/api/client';
import type { GeoPoint, Listing, ListingImage, ListingInput } from '../../lib/api/types';
import { errorMessage } from '../../lib/auth/messages';
import { CATEGORY_OPTIONS, CONDITION_OPTIONS, MAX_LISTING_PHOTOS } from '../../lib/listings/options';
import { toLocalPhoto, type LocalPhoto } from '../../lib/listings/photos';
import {
  serverFieldErrors,
  validateListingForm,
  type ListingForm,
  type ListingFormErrors,
} from '../../lib/listings/validation';
import { Colors, Typography, Spacing, Radii, Shadows } from '../../utils/theme';

const formFrom = (l: Listing): ListingForm => ({
  title: l.title,
  description: l.description,
  category: l.category,
  condition: l.condition,
  replacementValue: l.replacementValuePkr != null ? String(l.replacementValuePkr) : '',
  borrowingTerms: l.borrowingTerms ?? '',
  area: l.area ?? '',
  city: l.city ?? '',
  tags: l.tags.join(', '),
  teachMeEnabled: l.teachMeEnabled,
});

// Only the fields that differ from the saved listing are sent.
function changesFrom(saved: Listing, input: ListingInput): Partial<ListingInput> {
  const changes: Partial<ListingInput> = {};
  if (input.title !== saved.title) changes.title = input.title;
  if (input.description !== saved.description) changes.description = input.description;
  if (input.category !== saved.category) changes.category = input.category;
  if (input.condition !== saved.condition) changes.condition = input.condition;
  if ((input.replacementValuePkr ?? null) !== saved.replacementValuePkr) changes.replacementValuePkr = input.replacementValuePkr ?? null;
  if ((input.borrowingTerms ?? null) !== saved.borrowingTerms) changes.borrowingTerms = input.borrowingTerms ?? null;
  if ((input.area ?? null) !== saved.area) changes.area = input.area ?? null;
  if ((input.city ?? null) !== saved.city) changes.city = input.city ?? null;
  if (input.teachMeEnabled !== saved.teachMeEnabled) changes.teachMeEnabled = input.teachMeEnabled ?? false;
  if ((input.tags ?? []).join('\u0000') !== saved.tags.join('\u0000')) changes.tags = input.tags ?? [];
  return changes;
}

function FieldError({ message }: { message: string | undefined }) {
  return message ? <Text style={styles.errorText}>{message}</Text> : null;
}

export default function LendNewScreen() {
  const router = useRouter();
  const { id: editId } = useLocalSearchParams<{ id?: string }>();
  const editing = Boolean(editId);
  const listings = useListings();
  const { profile } = useAuth();
  const discovery = useDiscovery();

  const [form, setForm] = useState<ListingForm>({
    title: '',
    description: '',
    category: 'tools',
    condition: 'good',
    replacementValue: '',
    borrowingTerms: '',
    // A sensible default the owner can change; never more precise than this.
    area: profile?.neighborhood ?? '',
    city: profile?.city ?? '',
    tags: '',
    teachMeEnabled: false,
  });
  const [errors, setErrors] = useState<ListingFormErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState<Listing | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>(editing ? 'loading' : 'ready');
  const [loadError, setLoadError] = useState<unknown>(null);
  // Photos already on the listing that the owner keeps, and new ones to upload.
  const [keptImages, setKeptImages] = useState<ListingImage[]>([]);
  const [newPhotos, setNewPhotos] = useState<LocalPhoto[]>([]);
  // Pickup spot: as saved, and as chosen now. Only an explicit choice here
  // ever changes it.
  const [savedSpot, setSavedSpot] = useState<GeoPoint | null>(null);
  const [spot, setSpot] = useState<GeoPoint | null>(null);
  const [spotBusy, setSpotBusy] = useState(false);
  const [spotNote, setSpotNote] = useState<string | null>(null);
  const [pickingSpot, setPickingSpot] = useState(false);

  const set = <K extends keyof ListingForm>(key: K, value: ListingForm[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => (e[key] ? { ...e, [key]: undefined } : e));
  };

  const loadListing = useCallback(async () => {
    if (!editId) return;
    setLoadState('loading');
    try {
      const listing = await listings.get(editId);
      setSaved(listing);
      setForm(formFrom(listing));
      setKeptImages(listing.images);
      // The precise spot is the owner's own; failing to read it is not fatal.
      const location = await listings.getPickupLocation(editId).catch(() => null);
      const point = location ? { latitude: location.latitude, longitude: location.longitude } : null;
      setSavedSpot(point);
      setSpot(point);
      setLoadState('ready');
    } catch (err) {
      setLoadError(err);
      setLoadState('error');
    }
    // Loads once per listing; later revisions come from this screen's own save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editId]);

  useEffect(() => {
    void loadListing();
  }, [loadListing]);

  // The profile may finish loading after this screen opens.
  const neighborhood = profile?.neighborhood;
  const profileCity = profile?.city;
  useEffect(() => {
    if (!editing && neighborhood) setForm((f) => (f.area ? f : { ...f, area: neighborhood }));
    if (!editing && profileCity) setForm((f) => (f.city ? f : { ...f, city: profileCity }));
  }, [editing, neighborhood, profileCity]);

  const takeCurrentSpot = async () => {
    setSpotNote(null);
    setSpotBusy(true);
    const result = await discovery.currentPoint();
    setSpotBusy(false);
    if ('point' in result) {
      setSpot(result.point);
      return;
    }
    setSpotNote(
      result.problem === 'blocked'
        ? 'Location is turned off for NeighborShare in Settings. Pick the spot on the map instead.'
        : result.problem === 'denied'
          ? 'Location permission was not given. Pick the spot on the map instead.'
          : result.problem === 'services_off'
            ? 'Your phone’s location (GPS) is off. Turn it on and try again, or pick the spot on the map.'
            : result.problem === 'timeout'
              ? 'Finding your location took too long. Try again or pick the spot on the map.'
              : 'Your location is not available. Pick the spot on the map instead.',
    );
  };

  // Where the map picker opens: the chosen spot, the device, the search
  // area, the listing's city, or the pilot city.
  const pickerStart: GeoPoint = spot ?? discovery.devicePoint ?? discovery.origin ?? cityNamed(form.city) ?? CITIES[0]!;

  const spotChange = (): LocationChange => {
    if (spot && (!savedSpot || spot.latitude !== savedSpot.latitude || spot.longitude !== savedSpot.longitude)) return { set: spot };
    if (!spot && savedSpot) return { clear: true };
    return null;
  };

  const photoCount = keptImages.length + newPhotos.length;

  const pickImages = async () => {
    const remaining = MAX_LISTING_PHOTOS - photoCount;
    if (remaining <= 0) {
      Toast.show({ type: 'info', text1: `You can add up to ${MAX_LISTING_PHOTOS} photos` });
      return;
    }
    const permissionResult = await ImagePicker.requestMediaLibraryPermissionsAsync();

    if (!permissionResult.granted) {
      Toast.show({
        type: 'error',
        text1: 'Permission Denied',
        text2: 'NeighborShare needs library access to upload item files.',
      });
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      selectionLimit: remaining,
      quality: 0.8,
      // iOS: deliver HEIC photos as JPEG, which the server accepts.
      preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
    });

    if (!result.canceled) {
      const picked = result.assets.map(toLocalPhoto);
      const accepted = picked.filter((p): p is LocalPhoto => typeof p !== 'string');
      if (picked.includes('too_large')) Toast.show({ type: 'error', text1: 'Some photos are over 5 MB and were skipped' });
      else if (picked.includes('unsupported')) Toast.show({ type: 'error', text1: 'Only JPEG, PNG and WebP photos can be used' });
      setNewPhotos((prev) => [...prev, ...accepted].slice(0, MAX_LISTING_PHOTOS - keptImages.length));
    }
  };

  const [handleSubmit, submitting] = useSubmit(
    useCallback(async () => {
      setFormError(null);
      const { errors: found, input } = validateListingForm(form);
      if (!input) {
        setErrors(found);
        setFormError('Please check the highlighted fields.');
        return;
      }
      let result: SaveResult;
      try {
        if (editId && saved) {
          const removeIds = saved.images.filter((img) => !keptImages.some((k) => k.id === img.id)).map((img) => img.id);
          result = await listings.update(editId, changesFrom(saved, input), { add: newPhotos, removeIds }, spotChange());
        } else {
          result = await listings.create(input, newPhotos, spotChange());
        }
      } catch (err) {
        if (isApiError(err) && err.code === 'VALIDATION_ERROR') setErrors(serverFieldErrors(err.fieldIssues));
        setFormError(errorMessage(err));
        return;
      }
      if (result.locationError) {
        Toast.show({
          type: 'error',
          text1: editing ? 'Changes saved, but the pickup spot was not' : 'Item listed, but the pickup spot was not saved',
          text2: `${errorMessage(result.locationError)} You can set it by editing the listing.`,
        });
      } else if (result.failedPhotos > 0) {
        Toast.show({
          type: 'error',
          text1: editing ? 'Changes saved, but some photos failed' : 'Item listed, but some photos failed',
          text2: `${result.failedPhotos} photo(s) not uploaded. ${errorMessage(result.photoError)}`,
        });
      } else {
        Toast.show(
          editing
            ? { type: 'success', text1: 'Changes saved' }
            : { type: 'success', text1: '🎉 Item listed!', text2: 'Neighbors can now see your item' },
        );
      }
      router.back();
    }, [form, editId, editing, saved, keptImages, newPhotos, listings, router, spot, savedSpot]),
  );

  if (loadState !== 'ready') {
    return (
      <View style={[styles.container, styles.centered]}>
        {loadState === 'loading' ? (
          <ActivityIndicator size="large" color={Colors.green || '#2e7d32'} accessibilityLabel="Loading listing" />
        ) : (
          <>
            <Text style={styles.stateTitle}>Could not load this listing</Text>
            <Text style={styles.stateDesc}>{errorMessage(loadError)}</Text>
            <TouchableOpacity style={styles.stateBtn} onPress={() => void loadListing()} accessibilityRole="button">
              <Text style={styles.stateBtnText}>Try again</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => router.back()} accessibilityRole="button">
              <Text style={styles.stateLink}>Go back</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <SafeAreaView edges={['top']}>
          <View style={styles.headerRow}>
            <TouchableOpacity onPress={() => router.back()} style={styles.closeBtn} accessibilityLabel="Close">
              <Ionicons name="close" size={22} color={Colors.greenDark || '#1b5e20'} />
            </TouchableOpacity>
            <Text style={styles.headerTitle}>{editing ? 'Edit Listing' : 'List an Item'}</Text>
            <View style={{ width: 40 }} />
          </View>
        </SafeAreaView>
      </View>

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">

          <TouchableOpacity
            style={styles.photoUpload}
            onPress={pickImages}
            activeOpacity={0.7}
            disabled={submitting}
            accessibilityRole="button"
            accessibilityLabel="Add photos"
          >
            <Ionicons name="camera-outline" size={32} color={Colors.green || '#2e7d32'} />
            <Text style={styles.photoText}>Add Photos</Text>
            <Text style={styles.photoSub}>{photoCount}/{MAX_LISTING_PHOTOS} photos · JPEG, PNG or WebP, up to 5 MB</Text>
          </TouchableOpacity>

          {photoCount > 0 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.previewScroll} contentContainerStyle={styles.previewContainer}>
              {keptImages.map((img) => (
                <View key={img.id} style={styles.thumbnailWrapper}>
                  {img.url ? <Image source={{ uri: img.url }} style={styles.thumbnail} /> : <View style={[styles.thumbnail, styles.thumbnailEmpty]} />}
                  <TouchableOpacity
                    style={styles.removeBadge}
                    onPress={() => setKeptImages((prev) => prev.filter((k) => k.id !== img.id))}
                    accessibilityLabel="Remove photo"
                  >
                    <Ionicons name="close-circle" size={20} color="#ef4444" />
                  </TouchableOpacity>
                </View>
              ))}
              {newPhotos.map((photo, index) => (
                <View key={photo.uri} style={styles.thumbnailWrapper}>
                  <Image source={{ uri: photo.uri }} style={styles.thumbnail} />
                  <TouchableOpacity
                    style={styles.removeBadge}
                    onPress={() => setNewPhotos((prev) => prev.filter((_, i) => i !== index))}
                    accessibilityLabel="Remove photo"
                  >
                    <Ionicons name="close-circle" size={20} color="#ef4444" />
                  </TouchableOpacity>
                </View>
              ))}
            </ScrollView>
          )}

          {/* Title */}
          <View style={styles.field}>
            <Text style={styles.label}>Item Title *</Text>
            <TextInput
              style={[styles.input, errors.title && styles.inputError]}
              value={form.title}
              onChangeText={(v) => set('title', v)}
              placeholder="e.g. Bosch Power Drill"
              placeholderTextColor={Colors.slate}
              maxLength={80}
              accessibilityLabel="Item title"
            />
            <FieldError message={errors.title} />
          </View>

          {/* Description */}
          <View style={styles.field}>
            <Text style={styles.label}>Description *</Text>
            <TextInput
              style={[styles.input, styles.textarea, errors.description && styles.inputError]}
              value={form.description}
              onChangeText={(v) => set('description', v)}
              placeholder="Describe your item, model, what it's good for..."
              placeholderTextColor={Colors.slate}
              multiline
              numberOfLines={4}
              textAlignVertical="top"
              maxLength={2000}
              accessibilityLabel="Description"
            />
            <FieldError message={errors.description} />
          </View>

          {/* Category */}
          <View style={styles.field}>
            <Text style={styles.label}>Category</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.catScroll} contentContainerStyle={styles.catContent}>
              {CATEGORY_OPTIONS.map(cat => (
                <TouchableOpacity
                  key={cat.value}
                  style={[styles.catChip, form.category === cat.value && styles.catChipActive]}
                  onPress={() => set('category', cat.value)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: form.category === cat.value }}
                >
                  <Text style={[styles.catText, form.category === cat.value && styles.catTextActive]}>{cat.label}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>

          {/* Condition */}
          <View style={styles.field}>
            <Text style={styles.label}>Condition</Text>
            <View style={styles.conditionRow}>
              {CONDITION_OPTIONS.map(cond => (
                <TouchableOpacity
                  key={cond.value}
                  style={[styles.condBtn, form.condition === cond.value && styles.condBtnActive]}
                  onPress={() => set('condition', cond.value)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: form.condition === cond.value }}
                >
                  <View style={[styles.condDot, {
                    backgroundColor: cond.value === 'excellent' ? (Colors.green || '#2e7d32') : cond.value === 'good' ? '#f59e0b' : Colors.slate
                  }]} />
                  <Text style={[styles.condText, form.condition === cond.value && styles.condTextActive]}>{cond.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          {/* Area */}
          <View style={styles.field}>
            <Text style={styles.label}>Area (optional)</Text>
            <TextInput
              style={[styles.input, errors.area && styles.inputError]}
              value={form.area}
              onChangeText={(v) => set('area', v)}
              placeholder="e.g. UAF Hostel 3 — never your exact address"
              placeholderTextColor={Colors.slate}
              maxLength={80}
              accessibilityLabel="Area"
            />
            <FieldError message={errors.area} />
          </View>

          {/* City */}
          <View style={styles.field}>
            <Text style={styles.label}>City</Text>
            <TextInput
              style={[styles.input, errors.city && styles.inputError]}
              value={form.city}
              onChangeText={(v) => set('city', v)}
              placeholder="e.g. Faisalabad"
              placeholderTextColor={Colors.slate}
              maxLength={80}
              accessibilityLabel="City"
            />
            <FieldError message={errors.city} />
          </View>

          {/* Pickup spot */}
          <View style={styles.field}>
            <Text style={styles.label}>Pickup spot (recommended)</Text>
            <Text style={styles.spotHelp}>
              Lets neighbours nearby find this item. They only see an approximate spot about 0.5 km away, never your address.
              It stays where you put it, even when you move around.
            </Text>
            <View style={styles.spotStatus} accessibilityLabel={spot ? 'Pickup spot set' : 'No pickup spot'}>
              <Ionicons name={spot ? 'location' : 'location-outline'} size={16} color={spot ? (Colors.green || '#2e7d32') : Colors.slate} />
              <Text style={styles.spotStatusText}>
                {spot ? 'Pickup spot set' : 'No pickup spot yet: shown only when browsing the whole city'}
              </Text>
            </View>
            <View style={styles.spotActions}>
              <TouchableOpacity
                style={styles.spotBtn}
                onPress={() => void takeCurrentSpot()}
                disabled={spotBusy}
                accessibilityRole="button"
                accessibilityLabel="Use my current location as pickup spot"
              >
                {spotBusy ? (
                  <ActivityIndicator size="small" color={Colors.green || '#2e7d32'} />
                ) : (
                  <Ionicons name="navigate" size={14} color={Colors.green || '#2e7d32'} />
                )}
                <Text style={styles.spotBtnText}>Use current location</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.spotBtn} onPress={() => setPickingSpot(true)} accessibilityRole="button" accessibilityLabel="Pick pickup spot on map">
                <Ionicons name="map-outline" size={14} color={Colors.green || '#2e7d32'} />
                <Text style={styles.spotBtnText}>{spot ? 'Adjust on map' : 'Pick on map'}</Text>
              </TouchableOpacity>
              {spot ? (
                <TouchableOpacity style={styles.spotBtn} onPress={() => setSpot(null)} accessibilityRole="button" accessibilityLabel="Remove pickup spot">
                  <Text style={[styles.spotBtnText, { color: Colors.rose }]}>Remove</Text>
                </TouchableOpacity>
              ) : null}
            </View>
            {spotNote ? <Text style={styles.errorText}>{spotNote}</Text> : null}
          </View>
          <SpotPicker
            visible={pickingSpot}
            start={pickerStart}
            onCancel={() => setPickingSpot(false)}
            onConfirm={(p) => {
              setSpot(p);
              setSpotNote(null);
              setPickingSpot(false);
            }}
          />

          {/* Replacement value */}
          <View style={styles.field}>
            <Text style={styles.label}>Approximate value in rupees (optional)</Text>
            <TextInput
              style={[styles.input, errors.replacementValue && styles.inputError]}
              value={form.replacementValue}
              onChangeText={(v) => set('replacementValue', v)}
              placeholder="e.g. 15000"
              placeholderTextColor={Colors.slate}
              keyboardType="number-pad"
              maxLength={12}
              accessibilityLabel="Approximate value"
            />
            <FieldError message={errors.replacementValue} />
          </View>

          {/* Borrowing terms */}
          <View style={styles.field}>
            <Text style={styles.label}>Borrowing terms (optional)</Text>
            <TextInput
              style={[styles.input, styles.textareaSmall, errors.borrowingTerms && styles.inputError]}
              value={form.borrowingTerms}
              onChangeText={(v) => set('borrowingTerms', v)}
              placeholder="e.g. Return within 3 days, clean after use"
              placeholderTextColor={Colors.slate}
              multiline
              textAlignVertical="top"
              maxLength={1000}
              accessibilityLabel="Borrowing terms"
            />
            <FieldError message={errors.borrowingTerms} />
          </View>

          {/* Tags */}
          <View style={styles.field}>
            <Text style={styles.label}>Tags (comma-separated)</Text>
            <TextInput
              style={[styles.input, errors.tags && styles.inputError]}
              value={form.tags}
              onChangeText={(v) => set('tags', v)}
              placeholder="e.g. DIY, Home, Repairs"
              placeholderTextColor={Colors.slate}
              accessibilityLabel="Tags"
            />
            <FieldError message={errors.tags} />
          </View>

          {/* Teach Me toggle */}
          <View style={styles.field}>
            <TouchableOpacity
              style={[styles.teachToggle, form.teachMeEnabled && styles.teachToggleActive]}
              onPress={() => set('teachMeEnabled', !form.teachMeEnabled)}
              activeOpacity={0.8}
              accessibilityRole="switch"
              accessibilityState={{ checked: form.teachMeEnabled }}
            >
              <View style={styles.teachLeft}>
                <Text style={styles.teachIcon}>🎓</Text>
                <View style={styles.teachTextContainer}>
                  <Text style={styles.teachTitle}>Enable Teach Me Mode</Text>
                  <Text style={styles.teachSub}>Offer a 15-min demo. Earn 50 Karma per session.</Text>
                </View>
              </View>
              <View style={[styles.toggle, form.teachMeEnabled && styles.toggleOn]}>
                <View style={[styles.thumb, form.teachMeEnabled && styles.thumbOn]} />
              </View>
            </TouchableOpacity>
          </View>

          {/* Guidelines */}
          <View style={styles.guidelines}>
            <Ionicons name="shield-checkmark-outline" size={16} color={Colors.green || '#2e7d32'} />
            <Text style={styles.guidelinesText}>
              By listing, you confirm you own this item and agree to NeighborShare's lending guidelines.
            </Text>
          </View>

          {formError ? <Text style={[styles.errorText, styles.formError]} accessibilityRole="alert">{formError}</Text> : null}

          {/* Form Submit Primary CTA */}
          <TouchableOpacity
            style={[styles.submitBtn, submitting && styles.submitBtnBusy]}
            onPress={() => void handleSubmit()}
            activeOpacity={0.85}
            disabled={submitting}
            accessibilityRole="button"
            accessibilityLabel={editing ? 'Save changes' : 'List my item'}
            accessibilityState={{ busy: submitting, disabled: submitting }}
          >
            <LinearGradient
              colors={[Colors.green || '#2e7d32', Colors.greenDark || '#1b5e20']}
              style={styles.submitGrad}
              start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
            >
              {submitting ? (
                <ActivityIndicator color={Colors.white} />
              ) : (
                <Ionicons name="cloud-upload-outline" size={20} color={Colors.white} />
              )}
              <Text style={styles.submitText}>
                {submitting ? (editing ? 'Saving…' : 'Listing…') : editing ? 'Save Changes' : 'List My Item'}
              </Text>
            </LinearGradient>
          </TouchableOpacity>

          <View style={{ height: 40 }} />
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.offWhite },
  centered: { alignItems: 'center', justifyContent: 'center', padding: Spacing.xl },
  stateTitle: { fontSize: Typography.sizes.lg, fontWeight: Typography.weights.bold, color: Colors.greenDark || '#1b5e20' },
  stateDesc: { fontSize: Typography.sizes.base, color: Colors.slate, marginTop: Spacing.xs, textAlign: 'center' },
  stateBtn: { marginTop: Spacing.lg, backgroundColor: Colors.green || '#2e7d32', paddingHorizontal: Spacing.xl, paddingVertical: Spacing.sm + 2, borderRadius: Radii.full },
  stateBtnText: { color: Colors.white, fontWeight: Typography.weights.bold, fontSize: Typography.sizes.sm },
  stateLink: { marginTop: Spacing.md, color: Colors.slate, fontWeight: Typography.weights.semibold },
  header: { 
    backgroundColor: Colors.white, 
    paddingHorizontal: Spacing.xl, 
    paddingBottom: Spacing.md,
    borderBottomWidth: 1,
    borderColor: Colors.fog,
    ...Shadows.sm
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: Spacing.sm },
  closeBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#e8f5e9', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: Colors.fog },
  headerTitle: { fontSize: Typography.sizes.md, fontWeight: Typography.weights.bold, color: Colors.greenDark || '#1b5e20' },
  scroll: { padding: Spacing.xl },
  photoUpload: {
    backgroundColor: Colors.white, borderRadius: Radii.xl,
    borderWidth: 2, borderColor: Colors.green || '#2e7d32', borderStyle: 'dashed',
    padding: Spacing['2xl'], alignItems: 'center', marginBottom: Spacing.md,
    ...Shadows.sm,
  },
  photoText: { fontSize: Typography.sizes.md, fontWeight: Typography.weights.bold, color: Colors.greenDark || '#1b5e20', marginTop: Spacing.sm },
  photoSub: { fontSize: Typography.sizes.sm, color: Colors.slate, marginTop: 4, fontWeight: Typography.weights.medium },
  previewScroll: { marginHorizontal: -Spacing.xl, marginBottom: Spacing.xl },
  previewContainer: { paddingHorizontal: Spacing.xl, gap: Spacing.sm, flexDirection: 'row' },
  thumbnailWrapper: { position: 'relative' },
  thumbnail: { width: 75, height: 75, borderRadius: Radii.md, borderWidth: 1.5, borderColor: Colors.fog },
  thumbnailEmpty: { backgroundColor: Colors.fog },
  removeBadge: { position: 'absolute', top: -6, right: -6, backgroundColor: Colors.white, borderRadius: 10 },
  field: { marginBottom: Spacing.xl },
  label: { fontSize: Typography.sizes.sm, fontWeight: Typography.weights.bold, color: Colors.greenDark || '#1b5e20', marginBottom: Spacing.sm },
  input: {
    backgroundColor: Colors.white, borderWidth: 1.5, borderColor: Colors.fog,
    borderRadius: Radii.md, paddingHorizontal: Spacing.base, paddingVertical: Spacing.sm + 2,
    fontSize: Typography.sizes.base, color: Colors.greenDark || '#1b5e20', fontWeight: Typography.weights.medium, ...Shadows.sm,
  },
  textarea: { height: 100, paddingTop: Spacing.md },
  textareaSmall: { height: 70, paddingTop: Spacing.md },
  inputError: { borderColor: '#ef4444' },
  errorText: { color: '#b91c1c', fontSize: Typography.sizes.xs, marginTop: 4, fontWeight: Typography.weights.semibold },
  formError: { textAlign: 'center', marginBottom: Spacing.md, fontSize: Typography.sizes.sm },
  catScroll: { marginHorizontal: -Spacing.xl },
  catContent: { paddingHorizontal: Spacing.xl, gap: Spacing.sm },
  catChip: {
    backgroundColor: Colors.white, borderRadius: Radii.full,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    borderWidth: 1.5, borderColor: Colors.fog,
  },
  catChipActive: { backgroundColor: '#e8f5e9', borderColor: Colors.green || '#2e7d32' },
  catText: { fontSize: Typography.sizes.sm, color: Colors.slate, fontWeight: Typography.weights.semibold },
  catTextActive: { color: Colors.greenDark || '#1b5e20', fontWeight: Typography.weights.bold },
  conditionRow: { flexDirection: 'row', gap: Spacing.md },
  condBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: Colors.white, borderRadius: Radii.md, padding: Spacing.md,
    borderWidth: 1.5, borderColor: Colors.fog, justifyContent: 'center',
  },
  condBtnActive: { borderColor: Colors.green || '#2e7d32', backgroundColor: '#e8f5e9' },
  condDot: { width: 8, height: 8, borderRadius: 4 },
  condText: { fontSize: Typography.sizes.sm, color: Colors.slate, fontWeight: Typography.weights.semibold },
  condTextActive: { color: Colors.greenDark || '#1b5e20', fontWeight: Typography.weights.bold },
  teachToggle: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: Colors.white, borderRadius: Radii.lg, padding: Spacing.lg,
    borderWidth: 1.5, borderColor: Colors.fog, ...Shadows.sm,
  },
  teachToggleActive: { borderColor: Colors.green || '#2e7d32', backgroundColor: '#e8f5e9' },
  teachLeft: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, flex: 1 },
  teachIcon: { fontSize: 28 },
  teachTextContainer: { flex: 1 },
  teachTitle: { fontSize: Typography.sizes.base, fontWeight: Typography.weights.bold, color: Colors.greenDark || '#1b5e20' },
  teachSub: { fontSize: Typography.sizes.xs, color: Colors.slate, marginTop: 2, lineHeight: 16, fontWeight: Typography.weights.medium },
  toggle: { width: 46, height: 26, borderRadius: 13, backgroundColor: Colors.fog, justifyContent: 'center', paddingHorizontal: 3 },
  toggleOn: { backgroundColor: Colors.green || '#2e7d32' },
  thumb: { width: 20, height: 20, borderRadius: 10, backgroundColor: Colors.white, ...Shadows.sm },
  thumbOn: { alignSelf: 'flex-end' },
  guidelines: {
    flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.sm,
    backgroundColor: '#e8f5e9', borderRadius: Radii.lg,
    padding: Spacing.md, marginBottom: Spacing.xl, borderWidth: 1, borderColor: '#a5d6a7'
  },
  guidelinesText: { flex: 1, fontSize: Typography.sizes.xs, color: Colors.greenDark || '#1b5e20', lineHeight: 16, fontWeight: Typography.weights.semibold },
  submitBtn: { borderRadius: Radii.lg, overflow: 'hidden', ...Shadows.md },
  spotHelp: { fontSize: Typography.sizes.xs, color: Colors.slate, marginBottom: Spacing.sm, lineHeight: 16 },
  spotStatus: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: Spacing.sm },
  spotStatusText: { flex: 1, fontSize: Typography.sizes.sm, color: Colors.navyMid, fontWeight: Typography.weights.semibold },
  spotActions: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  spotBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderColor: Colors.fog, borderRadius: Radii.full,
    paddingHorizontal: Spacing.md, paddingVertical: 6,
  },
  spotBtnText: { fontSize: Typography.sizes.sm, fontWeight: Typography.weights.semibold, color: Colors.greenDark || '#1b5e20' },
  submitBtnBusy: { opacity: 0.7 },
  submitGrad: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.sm, paddingVertical: Spacing.base },
  submitText: { fontSize: Typography.sizes.md, fontWeight: Typography.weights.bold, color: Colors.white },
});