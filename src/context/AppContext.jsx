import { createContext, useContext, useState, useMemo } from 'react';

const AppContext = createContext(null);

export function AppProvider({ children }) {
  const [theme, setTheme] = useState('dark');
  const [mode, setMode] = useState('pro'); // 'pro' | 'simple'
  const [settingsUnlocked, setSettingsUnlocked] = useState(false);

  const value = useMemo(() => ({
    theme,
    toggleTheme: () => setTheme(t => (t === 'dark' ? 'light' : 'dark')),
    dense: mode === 'pro',
    simple: mode === 'simple',
    setPro: () => setMode('pro'),
    setSimple: () => setMode('simple'),
    settingsUnlocked,
    unlockSettings: () => setSettingsUnlocked(true),
    lockSettings: () => setSettingsUnlocked(false),
  }), [theme, mode, settingsUnlocked]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
