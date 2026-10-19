export type Item = {
  id: string;
  title: string;
  category: string;
  description: string;
  image: string;
  ownerId: string;
  ownerName: string;
  ownerAvatar: string;
  ownerTrustScore: number;
  distance: string;
  available: boolean;
  teachMeEnabled: boolean;
  condition: 'Excellent' | 'Good' | 'Fair';
  tags: string[];
  lat: number;
  lng: number;
  borrowCount: number;
};

export type User = {
  id: string;
  name: string;
  avatar: string;
  trustScore: number;
  karmaPoints: number;
  badges: Badge[];
  lendingCount: number;
  borrowCount: number;
  memberSince: string;
};

export type Badge = {
  id: string;
  name: string;
  icon: string;
  color: string;
  description: string;
};

export type Transaction = {
  id: string;
  itemId: string;
  itemTitle: string;
  itemImage: string;
  lenderId: string;
  lenderName: string;
  borrowerId: string;
  borrowerName: string;
  status: 'Pending' | 'Accepted' | 'In Use' | 'Completed' | 'Cancelled';
  qrCode: string;
  requestDate: string;
  startDate?: string;
  endDate?: string;
  teachMeRequested: boolean;
};

export const MOCK_USERS: User[] = [
  {
    id: 'u1',
    name: 'You',
    avatar: 'https://i.pravatar.cc/150?img=12',
    trustScore: 87,
    karmaPoints: 340,
    badges: [
      { id: 'b1', name: 'Power Driller', icon: '🔧', color: '#F59E0B', description: 'Borrowed a drill and learned to use it' },
      { id: 'b2', name: 'Good Neighbor', icon: '🏡', color: '#10B981', description: 'Completed 5 transactions without issues' },
      { id: 'b3', name: 'Quick Learner', icon: '⚡', color: '#8B5CF6', description: 'Completed 3 Teach Me sessions' },
    ],
    lendingCount: 12,
    borrowCount: 8,
    memberSince: 'Jan 2024',
  },
  {
    id: 'u2',
    name: 'Ahmed K.',
    avatar: 'https://i.pravatar.cc/150?img=33',
    trustScore: 94,
    karmaPoints: 520,
    badges: [],
    lendingCount: 24,
    borrowCount: 3,
    memberSince: 'Nov 2023',
  },
  {
    id: 'u3',
    name: 'Sara M.',
    avatar: 'https://i.pravatar.cc/150?img=47',
    trustScore: 91,
    karmaPoints: 280,
    badges: [],
    lendingCount: 15,
    borrowCount: 11,
    memberSince: 'Mar 2024',
  },
  {
    id: 'u4',
    name: 'Bilal R.',
    avatar: 'https://i.pravatar.cc/150?img=59',
    trustScore: 78,
    karmaPoints: 120,
    badges: [],
    lendingCount: 6,
    borrowCount: 18,
    memberSince: 'Jun 2024',
  },
  {
    id: 'u5',
    name: 'Fatima A.',
    avatar: 'https://i.pravatar.cc/150?img=25',
    trustScore: 96,
    karmaPoints: 780,
    badges: [],
    lendingCount: 38,
    borrowCount: 5,
    memberSince: 'Aug 2023',
  },
];

export const MOCK_ITEMS: Item[] = [
  {
    id: 'i1',
    title: 'Power Drill (Bosch)',
    category: 'Tools',
    description: 'Professional Bosch GSB 550 Power Drill. Perfect for home repairs, wall mounting, and woodwork. Comes with a full set of drill bits.',
    image: 'https://images.unsplash.com/photo-1504148455328-c376907d081c?w=600&q=80',
    ownerId: 'u2',
    ownerName: 'Ahmed K.',
    ownerAvatar: 'https://i.pravatar.cc/150?img=33',
    ownerTrustScore: 94,
    distance: '0.3 km',
    available: true,
    teachMeEnabled: true,
    condition: 'Excellent',
    tags: ['DIY', 'Repairs', 'Home'],
    lat: 24.8607,
    lng: 67.0011,
    borrowCount: 14,
  },
  {
    id: 'i2',
    title: 'DSLR Camera (Canon 200D)',
    category: 'Electronics',
    description: 'Canon EOS 200D with 18-55mm kit lens. Great for portrait, travel, or event photography. I can show you the basics too!',
    image: 'https://images.unsplash.com/photo-1502920917128-1aa500764cbd?w=600&q=80',
    ownerId: 'u3',
    ownerName: 'Sara M.',
    ownerAvatar: 'https://i.pravatar.cc/150?img=47',
    ownerTrustScore: 91,
    distance: '0.7 km',
    available: true,
    teachMeEnabled: true,
    condition: 'Good',
    tags: ['Photography', 'Events', 'Creative'],
    lat: 24.8621,
    lng: 67.0098,
    borrowCount: 9,
  },
  {
    id: 'i3',
    title: 'Aluminum Step Ladder',
    category: 'Tools',
    description: '6-foot aluminum step ladder. Sturdy and lightweight. Great for ceiling work, painting, or fixing lights.',
    image: 'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=600&q=80',
    ownerId: 'u5',
    ownerName: 'Fatima A.',
    ownerAvatar: 'https://i.pravatar.cc/150?img=25',
    ownerTrustScore: 96,
    distance: '1.1 km',
    available: true,
    teachMeEnabled: false,
    condition: 'Excellent',
    tags: ['Home', 'Repairs', 'Safety'],
    lat: 24.8589,
    lng: 67.0045,
    borrowCount: 21,
  },
  {
    id: 'i4',
    title: 'Sewing Machine (Singer)',
    category: 'Home',
    description: 'Singer heavy-duty sewing machine. Can do basic stitching, zippers, and hemming. Great for clothes alterations.',
    image: 'https://images.unsplash.com/photo-1585914924626-15adac1e6402?w=600&q=80',
    ownerId: 'u3',
    ownerName: 'Sara M.',
    ownerAvatar: 'https://i.pravatar.cc/150?img=47',
    ownerTrustScore: 91,
    distance: '0.7 km',
    available: true,
    teachMeEnabled: true,
    condition: 'Good',
    tags: ['Crafts', 'Clothing', 'DIY'],
    lat: 24.8618,
    lng: 67.0102,
    borrowCount: 7,
  },
  {
    id: 'i5',
    title: 'Pressure Washer',
    category: 'Tools',
    description: 'Electric pressure washer 1500W. Perfect for cleaning cars, driveways, patios, or outdoor furniture.',
    image: 'https://images.unsplash.com/photo-1558618047-3c8a4c0f2e68?w=600&q=80',
    ownerId: 'u4',
    ownerName: 'Bilal R.',
    ownerAvatar: 'https://i.pravatar.cc/150?img=59',
    ownerTrustScore: 78,
    distance: '1.4 km',
    available: false,
    teachMeEnabled: false,
    condition: 'Fair',
    tags: ['Cleaning', 'Car', 'Home'],
    lat: 24.8575,
    lng: 67.0132,
    borrowCount: 5,
  },
  {
    id: 'i6',
    title: 'Tent (4-Person Camping)',
    category: 'Outdoor',
    description: 'Decathlon 4-person tent, waterproof, easy setup with color-coded poles. Perfect for weekend camping trips.',
    image: 'https://images.unsplash.com/photo-1478131143081-80f7f84ca84d?w=600&q=80',
    ownerId: 'u2',
    ownerName: 'Ahmed K.',
    ownerAvatar: 'https://i.pravatar.cc/150?img=33',
    ownerTrustScore: 94,
    distance: '0.3 km',
    available: true,
    teachMeEnabled: true,
    condition: 'Good',
    tags: ['Camping', 'Outdoor', 'Adventure'],
    lat: 24.8610,
    lng: 67.0005,
    borrowCount: 11,
  },
  {
    id: 'i7',
    title: 'Projector (1080p Portable)',
    category: 'Electronics',
    description: 'Mini portable 1080p projector with HDMI and WiFi. Perfect for movie nights or presentations. Includes screen stand.',
    image: 'https://images.unsplash.com/photo-1517604931442-7e0c8ed2963c?w=600&q=80',
    ownerId: 'u5',
    ownerName: 'Fatima A.',
    ownerAvatar: 'https://i.pravatar.cc/150?img=25',
    ownerTrustScore: 96,
    distance: '1.1 km',
    available: true,
    teachMeEnabled: false,
    condition: 'Excellent',
    tags: ['Movies', 'Events', 'Tech'],
    lat: 24.8591,
    lng: 67.0051,
    borrowCount: 17,
  },
  {
    id: 'i8',
    title: 'Bread Maker Machine',
    category: 'Kitchen',
    description: 'Panasonic automatic bread maker. Makes fresh bread, pizza dough, and jam. I can share my favorite recipes!',
    image: 'https://images.unsplash.com/photo-1509440159596-0249088772ff?w=600&q=80',
    ownerId: 'u5',
    ownerName: 'Fatima A.',
    ownerAvatar: 'https://i.pravatar.cc/150?img=25',
    ownerTrustScore: 96,
    distance: '1.1 km',
    available: true,
    teachMeEnabled: true,
    condition: 'Excellent',
    tags: ['Cooking', 'Baking', 'Kitchen'],
    lat: 24.8593,
    lng: 67.0059,
    borrowCount: 8,
  },
];

export const MOCK_TRANSACTIONS: Transaction[] = [
  {
    id: 't1',
    itemId: 'i1',
    itemTitle: 'Power Drill (Bosch)',
    itemImage: 'https://images.unsplash.com/photo-1504148455328-c376907d081c?w=600&q=80',
    lenderId: 'u2',
    lenderName: 'Ahmed K.',
    borrowerId: 'u1',
    borrowerName: 'You',
    status: 'In Use',
    qrCode: 'NS-TXN-T1-2024',
    requestDate: '2 days ago',
    startDate: 'Yesterday',
    teachMeRequested: true,
  },
  {
    id: 't2',
    itemId: 'i6',
    itemTitle: 'Tent (4-Person Camping)',
    itemImage: 'https://images.unsplash.com/photo-1478131143081-80f7f84ca84d?w=600&q=80',
    lenderId: 'u2',
    lenderName: 'Ahmed K.',
    borrowerId: 'u1',
    borrowerName: 'You',
    status: 'Pending',
    qrCode: 'NS-TXN-T2-2024',
    requestDate: 'Today',
    teachMeRequested: false,
  },
  {
    id: 't3',
    itemId: 'i3',
    itemTitle: 'Aluminum Step Ladder',
    itemImage: 'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=600&q=80',
    lenderId: 'u1',
    lenderName: 'You',
    borrowerId: 'u4',
    borrowerName: 'Bilal R.',
    status: 'Completed',
    qrCode: 'NS-TXN-T3-2024',
    requestDate: '1 week ago',
    startDate: '6 days ago',
    endDate: '3 days ago',
    teachMeRequested: false,
  },
];

export const CATEGORIES = [
  { id: 'all', label: 'All', icon: '🏠' },
  { id: 'tools', label: 'Tools', icon: '🔧' },
  { id: 'electronics', label: 'Electronics', icon: '📷' },
  { id: 'home', label: 'Home', icon: '🛋️' },
  { id: 'outdoor', label: 'Outdoor', icon: '⛺' },
  { id: 'kitchen', label: 'Kitchen', icon: '🍳' },
];
