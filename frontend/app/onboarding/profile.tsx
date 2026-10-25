import { useRef, useState } from 'react';
import type { TextInput } from 'react-native';
import { useAuth } from '../../context/AuthContext';
import { errorMessage, fieldErrorsFrom } from '../../lib/auth/messages';
import { displayNameError, profileTextError } from '../../lib/auth/validation';
import { useSubmit } from '../../components/auth/useSubmit';
import { AuthHeader, AuthScreen, Card, Field, LinkRow, Notice, PrimaryButton } from '../../components/auth/AuthUI';

const FIELDS = ['displayName', 'city', 'neighborhood', 'bio'] as const;
type Form = Record<(typeof FIELDS)[number], string>;

// Shown until the backend reports the profile as complete (display name,
// city and neighborhood). Only the documented, user-editable fields are sent;
// completion itself is decided by the server.
export default function CompleteProfileScreen() {
  const { profile, updateProfile, signOut } = useAuth();
  const [form, setForm] = useState<Form>({
    displayName: profile?.displayName ?? '',
    city: profile?.city ?? '',
    neighborhood: profile?.neighborhood ?? '',
    bio: profile?.bio ?? '',
  });
  const [errors, setErrors] = useState<Partial<Form>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const cityRef = useRef<TextInput>(null);
  const areaRef = useRef<TextInput>(null);
  const bioRef = useRef<TextInput>(null);

  const set = (key: keyof Form) => (v: string) => {
    setForm((f) => ({ ...f, [key]: v }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const [save, saving] = useSubmit(async () => {
    setFormError(null);
    const found: Partial<Form> = {};
    const name = displayNameError(form.displayName, true);
    if (name) found.displayName = name;
    const city = profileTextError(form.city, 'city', 2, 80, true);
    if (city) found.city = city;
    const area = profileTextError(form.neighborhood, 'neighborhood', 2, 80, true);
    if (area) found.neighborhood = area;
    const bio = profileTextError(form.bio, 'bio', 1, 500, false);
    if (bio) found.bio = bio;
    setErrors(found);
    if (Object.keys(found).length) return;

    try {
      await updateProfile({
        displayName: form.displayName.trim(),
        city: form.city.trim(),
        neighborhood: form.neighborhood.trim(),
        bio: form.bio.trim() || null,
      });
      // Once the server marks the profile complete, navigation moves on.
    } catch (err) {
      const fieldErrors = fieldErrorsFrom(err, FIELDS);
      if (Object.keys(fieldErrors).length) setErrors(fieldErrors);
      else setFormError(errorMessage(err));
    }
  });
  const [leave, leaving] = useSubmit(() => signOut());

  return (
    <AuthScreen>
      <AuthHeader title="Complete your profile" subtitle="Tell your neighbors who you are and where you share." />
      <Card>
        {formError ? <Notice tone="error">{formError}</Notice> : null}
        <Field label="Display name" icon="person-outline" value={form.displayName} onChangeText={set('displayName')} error={errors.displayName}
          placeholder="Your name" autoCapitalize="words" autoComplete="name" textContentType="name" returnKeyType="next"
          onSubmitEditing={() => cityRef.current?.focus()} editable={!saving} />
        <Field ref={cityRef} label="City" icon="business-outline" value={form.city} onChangeText={set('city')} error={errors.city}
          placeholder="e.g. Lahore" autoCapitalize="words" textContentType="addressCity" returnKeyType="next"
          onSubmitEditing={() => areaRef.current?.focus()} editable={!saving} />
        <Field ref={areaRef} label="Neighborhood" icon="location-outline" value={form.neighborhood} onChangeText={set('neighborhood')}
          error={errors.neighborhood} placeholder="e.g. Gulberg" autoCapitalize="words" textContentType="sublocality" returnKeyType="next"
          onSubmitEditing={() => bioRef.current?.focus()} editable={!saving} />
        <Field ref={bioRef} label="About you (optional)" icon="chatbubble-ellipses-outline" value={form.bio} onChangeText={set('bio')}
          error={errors.bio} placeholder="What do you like to share or borrow?" multiline maxLength={500} editable={!saving} />
        <PrimaryButton title="Save and continue" onPress={() => void save()} loading={saving} disabled={leaving} />
      </Card>
      <LinkRow text="Not you?" link="Sign out" onPress={() => void leave()} />
    </AuthScreen>
  );
}
