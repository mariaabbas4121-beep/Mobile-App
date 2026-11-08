import type { ActivityFeed, ActivityItem } from '../api/types';
import { formatRange } from '../borrow/dates';

// Wording for activity entries, from the signed-in user's point of view.

const who = (item: ActivityItem) => (item.actor?.isYou ? 'You' : (item.actor?.displayName ?? 'A neighbour'));

export function describeActivity(item: ActivityItem): string {
  const title = item.listing?.title ?? 'an item';
  const you = item.actor?.isYou ?? false;
  switch (item.type) {
    case 'request_received':
      return `${who(item)} asked to borrow your ${title}`;
    case 'request_sent':
      return `You asked to borrow ${title}`;
    case 'request_accepted':
      return you ? `You accepted a request for ${title}` : `${who(item)} accepted your request for ${title}`;
    case 'request_declined':
      return you ? `You declined a request for ${title}` : `${who(item)} declined your request for ${title}`;
    case 'request_cancelled':
      return you ? `You cancelled your request for ${title}` : `${who(item)} cancelled their request for ${title}`;
    case 'message':
      return you ? `You sent a message about ${title}` : `${who(item)} sent you a message about ${title}`;
    case 'listing_created':
      return `You listed ${title}`;
    case 'listing_archived':
      return `You archived ${title}`;
    case 'pickup_authorized':
      return you
        ? `You authorized ${item.recipientName ?? 'someone'} to collect ${title}`
        : `${who(item)} authorized ${item.recipientName ?? 'someone'} to collect ${title}`;
    case 'pickup_authorization_revoked':
      return you
        ? `You revoked ${item.recipientName ?? 'a'}’s pickup authorization for ${title}`
        : `${who(item)} revoked ${item.recipientName ?? 'a'}’s pickup authorization for ${title}`;
    case 'pickup_authorization_redeemed':
      return `${item.recipientName ?? 'The authorized person'}’s pickup code was used for ${title}`;
    case 'item_handed_over':
      return you
        ? `You handed over ${title}${item.handoverMethod === 'authorized' && item.recipientName ? ` to ${item.recipientName}` : ''}`
        : `${who(item)} handed over ${title}${
            item.handoverMethod === 'authorized' && item.recipientName ? ` to ${item.recipientName}` : ' to you'
          }`;
  }
}

// The borrowing dates, for request entries.
export const activityDates = (item: ActivityItem) => (item.request ? formatRange(item.request.startDate, item.request.endDate) : null);

export const ACTIVITY_ICONS: Record<ActivityItem['type'], { icon: string; color: string }> = {
  request_received: { icon: 'arrow-down-circle-outline', color: '#3b82f6' },
  request_sent: { icon: 'arrow-up-circle-outline', color: '#f59e0b' },
  request_accepted: { icon: 'checkmark-circle-outline', color: '#2e7d32' },
  request_declined: { icon: 'close-circle-outline', color: '#ef4444' },
  request_cancelled: { icon: 'remove-circle-outline', color: '#64748b' },
  message: { icon: 'chatbubble-ellipses-outline', color: '#0f766e' },
  listing_created: { icon: 'pricetag-outline', color: '#1b5e20' },
  listing_archived: { icon: 'archive-outline', color: '#64748b' },
  pickup_authorized: { icon: 'qr-code-outline', color: '#1d4ed8' },
  pickup_authorization_revoked: { icon: 'ban-outline', color: '#b91c1c' },
  pickup_authorization_redeemed: { icon: 'scan-outline', color: '#0f766e' },
  item_handed_over: { icon: 'cube-outline', color: '#2e7d32' },
};

const SOURCE_NAMES: Record<ActivityFeed['unavailable'][number], string> = {
  borrowRequests: 'borrow requests',
  conversations: 'messages',
  listings: 'your listings',
  handovers: 'pickups',
};

export function unavailableNote(feed: ActivityFeed): string | null {
  if (feed.unavailable.length === 0) return null;
  return `Some activity could not be loaded right now (${feed.unavailable.map((s) => SOURCE_NAMES[s]).join(', ')}). Pull down to try again.`;
}
