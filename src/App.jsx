import { useState } from 'react';
import { AppProvider, useApp } from './context/AppContext';
import Header from './components/Header';
import Footer from './components/Footer';
import MultiChart from './pages/MultiChart';
import ProTerminal from './pages/ProTerminal';
import Dashboard from './pages/Dashboard';
import LogPage from './pages/LogPage';
import AutoTrade from './pages/AutoTrade';
import Settings from './pages/Settings';

function Shell() {
  const { theme } = useApp();
  const [page, setPage] = useState('dash');

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
      </div>

      <Footer />
    </div>
  );
}

export default function App() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}
