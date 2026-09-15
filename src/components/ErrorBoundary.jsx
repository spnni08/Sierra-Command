import { Component } from 'react';

// Generic error boundary for wrapping data-dependent panels (tables fed by
// worker API responses) so a malformed/incomplete response crashes only
// that panel instead of the whole page — everything else (header, nav,
// sibling panels) keeps working. Must be a class component:
// componentDidCatch/getDerivedStateFromError have no functional-component
// equivalent. Styled with the app's existing CSS variables to match
// StatusPanel's error state (dark/light theme via var(--acc)/var(--txt2)).
export default class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary] caught render error', error, info);
  }

  handleRetry = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontFamily: "'IBM Plex Mono',monospace", fontSize: 11, color: 'var(--acc)' }}>
          <div>{this.props.message || 'Dieser Bereich konnte nicht dargestellt werden — unerwartete oder unvollständige Daten.'}</div>
          <button onClick={this.handleRetry} style={{ background: 'transparent', border: '1px solid var(--line2)', color: 'var(--txt)', fontFamily: 'inherit', fontSize: 10, padding: '3px 9px', cursor: 'pointer' }}>
            ERNEUT VERSUCHEN
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
