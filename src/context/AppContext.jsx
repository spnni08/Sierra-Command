import { createContext, useContext, useState, useMemo } from 'react';

const AppContext = createContext(null);

const TRADE_NOTIFICATIONS_KEY = 'sierra.tradeNotificationsEnabled';

function readTradeNotificationsSetting() {
  try {
    const raw = localStorage.getItem(TRADE_NOTIFICATIONS_KEY);
    return raw === null ? true : raw === 'true'; // default ON
  } catch {
    return true; // localStorage unavailable (private mode etc.) — keep default
  }
}

export function AppProvider({ children }) {
  const [theme, setTheme] = useState('dark');
  const [mode, setMode] = useState('pro'); // 'pro' | 'simple'
  const [settingsUnlocked, setSettingsUnlocked] = useState(false);
  const [tradeNotificationsEnabled, setTradeNotificationsEnabled] = useState(readTradeNotificationsSetting);

  const setTradeNotifications = (enabled) => {
    setTradeNotificationsEnabled(enabled);
    try {
      localStorage.setItem(TRADE_NOTIFICATIONS_KEY, String(enabled));
    } catch {
      // localStorage unavailable — setting stays in-memory for this session
    }
  };

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
    tradeNotificationsEnabled,
    setTradeNotifications,
  }), [theme, mode, settingsUnlocked, tradeNotificationsEnabled]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
