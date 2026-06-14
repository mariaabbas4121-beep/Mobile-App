import { useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  TextInput, KeyboardAvoidingView, Platform, Image,
} from 'react-native';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import Toast from 'react-native-toast-message';
import * as ImagePicker from 'expo-image-picker'; // 1. Import the Picker
import { useApp } from '../../context/AppContext';
import { Colors, Typography, Spacing, Radii, Shadows } from '../../utils/theme';

const CATEGORIES = ['Tools', 'Electronics', 'Home', 'Outdoor', 'Kitchen', 'Sports', 'Books', 'Other'];
const CONDITIONS = ['Excellent', 'Good', 'Fair'] as const;

export default function LendNewScreen() {
  const router = useRouter();
  const { addItem } = useApp();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('Tools');
  const [condition, setCondition] = useState<'Excellent' | 'Good' | 'Fair'>('Good');
  const [teachMe, setTeachMe] = useState(false);
  const [tags, setTags] = useState('');
  const [submitting, setSubmitting] = useState(false);
  
  // 2. Track selected images locally
  const [images, setImages] = useState<string[]>([]);

  // 3. Logic to access device photos
  const pickImages = async () => {
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
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsMultipleSelection: true, // Allows up to 5 files
      selectionLimit: 5,
      quality: 0.8,
    });

    if (!result.canceled) {
      const selectedUris = result.assets.map(asset => asset.uri);
      setImages(prev => [...prev, ...selectedUris].slice(0, 5)); // Keep max 5
    }
  };

  const removeImage = (index: number) => {
    setImages(prev => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = () => {
    if (!title || !description) {
      Toast.show({ type: 'error', text1: 'Please fill title and description' });
      return;
    }
    setSubmitting(true);
    setTimeout(() => {
      addItem({
        title,
        description,
        category,
        condition,
        teachMeEnabled: teachMe,
        tags: tags.split(',').map(t => t.trim()).filter(Boolean),
        images: images, // Pass image array to application context state
      });
      setSubmitting(false);
      Toast.show({ type: 'success', text1: '🎉 Item listed!', text2: 'Neighbors can now see your item' });
      router.back();
    }, 1000);
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <SafeAreaView edges={['top']}>
          <View style={styles.headerRow}>
            <TouchableOpacity onPress={() => router.back()} style={styles.closeBtn}>
              <Ionicons name="close" size={22} color={Colors.greenDark || '#1b5e20'} />
            </TouchableOpacity>
            <Text style={styles.headerTitle}>List an Item</Text>
            <View style={{ width: 40 }} />
          </View>
        </SafeAreaView>
      </View>

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">

          {/* 4. Swapped wrapper view with TouchableOpacity container */}
          <TouchableOpacity 
            style={styles.photoUpload} 
            onPress={pickImages}
            activeOpacity={0.7}
          >
            <Ionicons name="camera-outline" size={32} color={Colors.green || '#2e7d32'} />
            <Text style={styles.photoText}>Add Photos</Text>
            <Text style={styles.photoSub}>{images.length}/5 photos selected (tap to upload)</Text>
          </TouchableOpacity>

          {/* 5. Render Selected Thumbnail Previews */}
          {images.length > 0 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.previewScroll} contentContainerStyle={styles.previewContainer}>
              {images.map((uri, index) => (
                <View key={index} style={styles.thumbnailWrapper}>
                  <Image source={{ uri }} style={styles.thumbnail} />
                  <TouchableOpacity style={styles.removeBadge} onPress={() => removeImage(index)}>
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
              style={styles.input}
              value={title}
              onChangeText={setTitle}
              placeholder="e.g. Bosch Power Drill"
              placeholderTextColor={Colors.slate}
            />
          </View>

          {/* Description */}
          <View style={styles.field}>
            <Text style={styles.label}>Description *</Text>
            <TextInput
              style={[styles.input, styles.textarea]}
              value={description}
              onChangeText={setDescription}
              placeholder="Describe your item, model, what it's good for..."
              placeholderTextColor={Colors.slate}
              multiline
              numberOfLines={4}
              textAlignVertical="top"
            />
          </View>

          {/* Category */}
          <View style={styles.field}>
            <Text style={styles.label}>Category</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.catScroll} contentContainerStyle={styles.catContent}>
              {CATEGORIES.map(cat => (
                <TouchableOpacity
                  key={cat}
                  style={[styles.catChip, category === cat && styles.catChipActive]}
                  onPress={() => setCategory(cat)}
                >
                  <Text style={[styles.catText, category === cat && styles.catTextActive]}>{cat}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>

          {/* Condition */}
          <View style={styles.field}>
            <Text style={styles.label}>Condition</Text>
            <View style={styles.conditionRow}>
              {CONDITIONS.map(cond => (
                <TouchableOpacity
                  key={cond}
                  style={[styles.condBtn, condition === cond && styles.condBtnActive]}
                  onPress={() => setCondition(cond)}
                >
                  <View style={[styles.condDot, {
                    backgroundColor: cond === 'Excellent' ? (Colors.green || '#2e7d32') : cond === 'Good' ? '#f59e0b' : Colors.slate
                  }]} />
                  <Text style={[styles.condText, condition === cond && styles.condTextActive]}>{cond}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          {/* Tags */}
          <View style={styles.field}>
            <Text style={styles.label}>Tags (comma-separated)</Text>
            <TextInput
              style={styles.input}
              value={tags}
              onChangeText={setTags}
              placeholder="e.g. DIY, Home, Repairs"
              placeholderTextColor={Colors.slate}
            />
          </View>

          {/* Teach Me toggle */}
          <View style={styles.field}>
            <TouchableOpacity
              style={[styles.teachToggle, teachMe && styles.teachToggleActive]}
              onPress={() => setTeachMe(v => !v)}
              activeOpacity={0.8}
            >
              <View style={styles.teachLeft}>
                <Text style={styles.teachIcon}>🎓</Text>
                <View style={styles.teachTextContainer}>
                  <Text style={styles.teachTitle}>Enable Teach Me Mode</Text>
                  <Text style={styles.teachSub}>Offer a 15-min demo. Earn 50 Karma per session.</Text>
                </View>
              </View>
              <View style={[styles.toggle, teachMe && styles.toggleOn]}>
                <View style={[styles.thumb, teachMe && styles.thumbOn]} />
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

          {/* Form Submit Primary CTA */}
          <TouchableOpacity
            style={styles.submitBtn}
            onPress={handleSubmit}
            activeOpacity={0.85}
            disabled={submitting}
          >
            <LinearGradient
              colors={[Colors.green || '#2e7d32', Colors.greenDark || '#1b5e20']}
              style={styles.submitGrad}
              start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
            >
              <Ionicons name="cloud-upload-outline" size={20} color={Colors.white} />
              <Text style={styles.submitText}>{submitting ? 'Listing…' : 'List My Item'}</Text>
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
  removeBadge: { position: 'absolute', top: -6, right: -6, backgroundColor: Colors.white, borderRadius: 10 },
  field: { marginBottom: Spacing.xl },
  label: { fontSize: Typography.sizes.sm, fontWeight: Typography.weights.bold, color: Colors.greenDark || '#1b5e20', marginBottom: Spacing.sm },
  input: {
    backgroundColor: Colors.white, borderWidth: 1.5, borderColor: Colors.fog,
    borderRadius: Radii.md, paddingHorizontal: Spacing.base, paddingVertical: Spacing.sm + 2,
    fontSize: Typography.sizes.base, color: Colors.greenDark || '#1b5e20', fontWeight: Typography.weights.medium, ...Shadows.sm,
  },
  textarea: { height: 100, paddingTop: Spacing.md },
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
  submitGrad: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.sm, paddingVertical: Spacing.base },
  submitText: { fontSize: Typography.sizes.md, fontWeight: Typography.weights.bold, color: Colors.white },
});