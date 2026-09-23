import { useState, useEffect } from 'react';
import { AppProvider, useApp } from './context/AppContext';
import TradeNotificationsProvider from './context/TradeNotificationsProvider';
import Header from './components/Header';
import Footer from './components/Footer';
import UpdateAvailableModal from './components/UpdateAvailableModal';
import TradeToasts from './components/TradeToasts';
import MultiChart from './pages/MultiChart';
import ProTerminal from './pages/ProTerminal';
import Dashboard from './pages/Dashboard';
import LogPage from './pages/LogPage';
import AutoTrade from './pages/AutoTrade';
import Settings from './pages/Settings';
import Auswertung from './pages/Auswertung';
import LoginGate from './components/LoginGate';

function Shell() {
  const { theme } = useApp();
  // A direct link/reload with ?date= (from LogPage's calendar day filter —
  // see LogPage.jsx's applyDateFilter) should land on the Log page itself,
  // not the Dashboard default, so the filtered view is actually reachable
  // by URL. Read once at mount; LogPage owns re-reading/writing `date` for
  // the rest of its lifetime (see its own popstate listener). Same idea for
  // ?view=cards (Auswertung.jsx's Tabelle/Kacheln toggle) — without this, a
  // shared "card view" link would land on the Dashboard instead, since
  // Auswertung.jsx only controls its OWN internal view state, not which
  // page is showing.
  const [page, setPage] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('date')) return 'log';
    if (params.get('view')) return 'auswertung';
    return 'dash';
  });

  // Leaving the Log/Auswertung page via the header nav (not via LogPage's
  // own "Filter entfernen" or Auswertung's own view toggle) would otherwise
  // strand a stale ?date=/?view= in the URL bar — strip it so navigating to
  // Dashboard/ProTerminal/etc. doesn't carry a filter/view param that page
  // doesn't understand.
  useEffect(() => {
    if (page !== 'log' && page !== 'auswertung' && window.location.search) {
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, [page]);

  return (
    <div
      data-theme={theme}
      style={{
        height: '100vh', minHeight: 600, display: 'grid', gridTemplateRows: '38px 30px 1fr 24px',
        background: 'var(--bg)', color: 'var(--txt)', fontFamily: "'IBM Plex Sans',system-ui,sans-serif",
        fontSize: 12, overflow: 'hidden',
      }}
    >
      <Header page={page} setPage={setPage} />

      <div style={{ overflow: 'hidden', minHeight: 0 }}>
        {page === 'multi' && <MultiChart />}
        {page === 'pro' && <ProTerminal />}
        {page === 'dash' && <Dashboard goAutoSettings={() => setPage('autosettings')} goLog={() => setPage('log')} />}
        {page === 'log' && <LogPage />}
        {page === 'autosettings' && <AutoTrade />}
        {page === 'settings' && <Settings />}
        {page === 'auswertung' && <Auswertung />}
      </div>

      <Footer />
      <UpdateAvailableModal />
      <TradeToasts />
      <TradeNotificationsProvider />
    </div>
  );
}

export default function App() {
  return (
    <LoginGate>
      <AppProvider>
        <Shell />
      </AppProvider>
    </LoginGate>
  );
}
