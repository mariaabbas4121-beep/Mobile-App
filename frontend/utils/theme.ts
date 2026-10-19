// NeighborShare Design System
// Palette: deep navy base, warm amber accent, soft sage trust color
export const Colors = {
  // Core
  navy: '#0F172A',
  navyMid: '#1E293B',
  navyLight: '#334155',
  slate: '#64748B',
  slateLight: '#94A3B8',
  fog: '#E2E8F0',
  white: '#FFFFFF',
  offWhite: '#F8FAFC',

  // Accent — warm amber for actions, energy, community
  amber: '#F59E0B',
  amberLight: '#FCD34D',
  amberPale: '#FEF3C7',
  amberDark: '#D97706',

  // Trust — sage green for verified, safe, completed
  sage: '#10B981',
  sagePale: '#D1FAE5',
  sageDark: '#059669',

  // Green aliases used by existing screens; keep their established colors.
  green: '#2E7D32',
  greenDark: '#1B5E20',

  // Borrow — sky blue for active borrows
  sky: '#0EA5E9',
  skyPale: '#E0F2FE',

  // Alert / Warning
  rose: '#F43F5E',
  rosePale: '#FFE4E6',

  // Karma / Special
  violet: '#8B5CF6',
  violetPale: '#EDE9FE',

  // Transparent overlays
  overlayDark: 'rgba(15, 23, 42, 0.85)',
  overlayMid: 'rgba(15, 23, 42, 0.5)',
};

export const Typography = {
  // Display — used for headings, hero text
  display: 'System', // falls back to SF Pro on iOS, Roboto on Android
  body: 'System',

  sizes: {
    xs: 11,
    sm: 13,
    base: 15,
    md: 17,
    lg: 20,
    xl: 24,
    '2xl': 30,
    '3xl': 36,
  },

  weights: {
    regular: '400' as const,
    medium: '500' as const,
    semibold: '600' as const,
    bold: '700' as const,
    extrabold: '800' as const,
  },
};

export const Spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  base: 16,
  lg: 20,
  xl: 24,
  '2xl': 32,
  '3xl': 48,
  '4xl': 64,
};

export const Radii = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  '2xl': 28,
  full: 9999,
};

export const Shadows = {
  sm: {
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
    elevation: 2,
  },
  md: {
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 12,
    elevation: 5,
  },
  lg: {
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.18,
    shadowRadius: 24,
    elevation: 10,
  },
  amber: {
    shadowColor: '#F59E0B',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 12,
    elevation: 6,
  },
};
