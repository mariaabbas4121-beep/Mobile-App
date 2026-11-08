import type { PickupAuthorizationStatus } from '../api/types';

export const AUTH_STATUS: Record<PickupAuthorizationStatus, { label: string; color: string; bg: string }> = {
  active: { label: 'Active', color: '#1d4ed8', bg: '#dbeafe' },
  redeemed: { label: 'Used', color: '#1b5e20', bg: '#e8f5e9' },
  revoked: { label: 'Revoked', color: '#b91c1c', bg: '#fee2e2' },
  expired: { label: 'Expired', color: '#92400e', bg: '#fef3c7' },
};

export const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
