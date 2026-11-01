import React, { createContext, useContext, useState, ReactNode } from 'react';
import { MOCK_ITEMS, MOCK_TRANSACTIONS, MOCK_USERS, Item, Transaction, User } from '../data/mockData';

// The listing a prototype borrow request is made for.
export type BorrowTarget = { id: string; title: string; image: string; ownerId: string; ownerName: string };

// Prototype state for the screens that are not yet backed by the API: sample
// items for the map, and on-device borrow transactions. Real listings live in
// ListingsContext; authentication in AuthContext.
type AppContextType = {
  currentUser: User;
  items: Item[];
  transactions: Transaction[];
  requestBorrow: (item: BorrowTarget, teachMe: boolean) => Transaction;
  completeTransaction: (txnId: string) => void;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  activeCategory: string;
  setActiveCategory: (c: string) => void;
};

const AppContext = createContext<AppContextType | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [items] = useState<Item[]>(MOCK_ITEMS);
  const [transactions, setTransactions] = useState<Transaction[]>(MOCK_TRANSACTIONS);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState('all');
  const currentUser = MOCK_USERS[0];

  const requestBorrow = (item: BorrowTarget, teachMe: boolean): Transaction => {
    const newTxn: Transaction = {
      id: `t${Date.now()}`,
      itemId: item.id,
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

  return (
    <AppContext.Provider value={{
      currentUser,
      items,
      transactions,
      requestBorrow,
      completeTransaction,
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
