import React, { createContext, useContext, useState, ReactNode } from 'react';
import { MOCK_ITEMS, MOCK_TRANSACTIONS, MOCK_USERS, Item, Transaction, User } from '../data/mockData';

type AppContextType = {
  currentUser: User;
  items: Item[];
  transactions: Transaction[];
  isLoggedIn: boolean;
  login: () => void;
  logout: () => void;
  requestBorrow: (itemId: string, teachMe: boolean) => Transaction;
  completeTransaction: (txnId: string) => void;
  addItem: (item: Partial<Item>) => void;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  activeCategory: string;
  setActiveCategory: (c: string) => void;
};

const AppContext = createContext<AppContextType | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [items, setItems] = useState<Item[]>(MOCK_ITEMS);
  const [transactions, setTransactions] = useState<Transaction[]>(MOCK_TRANSACTIONS);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState('all');
  const currentUser = MOCK_USERS[0];

  const login = () => setIsLoggedIn(true);
  const logout = () => setIsLoggedIn(false);

  const requestBorrow = (itemId: string, teachMe: boolean): Transaction => {
    const item = items.find(i => i.id === itemId)!;
    const newTxn: Transaction = {
      id: `t${Date.now()}`,
      itemId,
      itemTitle: item.title,
      itemImage: item.image,
      lenderId: item.ownerId,
      lenderName: item.ownerName,
      borrowerId: 'u1',
      borrowerName: 'You',
      status: 'Pending',
      qrCode: `NS-TXN-${Date.now()}`,
      requestDate: 'Just now',
      teachMeRequested: teachMe,
    };
    setTransactions(prev => [newTxn, ...prev]);
    return newTxn;
  };

  const completeTransaction = (txnId: string) => {
    setTransactions(prev =>
      prev.map(t => t.id === txnId ? { ...t, status: 'Completed' } : t)
    );
  };

  const addItem = (partial: Partial<Item>) => {
    const newItem: Item = {
      id: `i${Date.now()}`,
      title: partial.title || 'New Item',
      category: partial.category || 'Tools',
      description: partial.description || '',
      image: partial.image || 'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=600&q=80',
      ownerId: 'u1',
      ownerName: 'You',
      ownerAvatar: 'https://i.pravatar.cc/150?img=12',
      ownerTrustScore: 87,
      distance: '0.0 km',
      available: true,
      teachMeEnabled: partial.teachMeEnabled || false,
      condition: partial.condition || 'Good',
      tags: partial.tags || [],
      lat: 24.8607,
      lng: 67.0011,
      borrowCount: 0,
    };
    setItems(prev => [newItem, ...prev]);
  };

  return (
    <AppContext.Provider value={{
      currentUser,
      items,
      transactions,
      isLoggedIn,
      login,
      logout,
      requestBorrow,
      completeTransaction,
      addItem,
      searchQuery,
      setSearchQuery,
      activeCategory,
      setActiveCategory,
    }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
