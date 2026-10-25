import { Redirect } from 'expo-router';

// Entry point of the signed-out group.
export default function AuthIndex() {
  return <Redirect href="/auth/welcome" />;
}
