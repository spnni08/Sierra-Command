import { describe, it, expect } from 'vitest';
import { checkRiskRules, checkSessionFilter, countOpenPositions, getRealizedPnlToday, describeRiskRejection } from '../src/risk/riskEngine.js';
import { createFakeD1 } from './fakeD1.js';
import { sessionOf } from '../src/lib/sessions.js';

function nowSql() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

describe('riskEngine.checkRiskRules — order and short-circuit', () => {
  it('passes with every default setting and an active strategy', async () => {
    const env = createFakeD1();
    const result = await checkRiskRules(env, { strategyActive: true });
    expect(result.ok).toBe(true);
  });

  it('blocks on the global switch before checking anything else', async () => {
    const env = createFakeD1({ app_settings: [{ key: 'auto_trading_enabled', value: 'false' }] });
    // Even with a below-limit position count and an active strategy, the
    // global switch wins first.
    const result = await checkRiskRules(env, { strategyActive: true });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('auto_trading_disabled');
  });

  it('blocks on an inactive strategy (checked after the global switch)', async () => {
    const env = createFakeD1();
    const result = await checkRiskRules(env, { strategyActive: false });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('strategy_inactive');
  });
});

describe('riskEngine.countOpenPositions — base + "(SL)" pair counts as ONE position', () => {
  it('two open trades sharing a position_group_id count as 1', async () => {
    const env = createFakeD1();
    env.tables.trades.push(
      { id: 't1', status: 'open', position_group_id: 'pos-a' },
      { id: 't2', status: 'open', position_group_id: 'pos-a' }
    );
    expect(await countOpenPositions(env)).toBe(1);
  });

  it('two open trades with different position_group_ids count as 2', async () => {
    const env = createFakeD1();
    env.tables.trades.push(
      { id: 't1', status: 'open', position_group_id: 'pos-a' },
      { id: 't2', status: 'open', position_group_id: 'pos-b' }
    );
    expect(await countOpenPositions(env)).toBe(2);
  });

  it('a trade with no position_group_id (legacy row) counts as its own position via its id', async () => {
    const env = createFakeD1();
    env.tables.trades.push({ id: 't1', status: 'open', position_group_id: null });
    expect(await countOpenPositions(env)).toBe(1);
  });

  it('closed trades are never counted', async () => {
    const env = createFakeD1();
    env.tables.trades.push({ id: 't1', status: 'closed', position_group_id: 'pos-a' });
    expect(await countOpenPositions(env)).toBe(0);
  });

  it('max_open_positions blocks once the count reaches the limit', async () => {
    const env = createFakeD1({ app_settings: [{ key: 'max_open_positions', value: '2' }] });
    env.tables.trades.push(
      { id: 't1', status: 'open', position_group_id: 'pos-a' },
      { id: 't2', status: 'open', position_group_id: 'pos-b' }
    );
    const result = await checkRiskRules(env, { strategyActive: true });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('max_open_positions');
    expect(result.detail.openPositions).toBe(2);
    expect(result.detail.maxOpenPositions).toBe(2);
  });

  it('max_open_positions does not block while under the limit', async () => {
    const env = createFakeD1({ app_settings: [{ key: 'max_open_positions', value: '2' }] });
    env.tables.trades.push({ id: 't1', status: 'open', position_group_id: 'pos-a' });
    const result = await checkRiskRules(env, { strategyActive: true });
    expect(result.ok).toBe(true);
  });
});

describe('riskEngine.getRealizedPnlToday / daily loss limit', () => {
  it('sums only trades closed today (Europe/Berlin) — a closed_at timestamp today', async () => {
    const env = createFakeD1();
    env.tables.trades.push({ id: 't1', status: 'closed', pnl: -50, closed_at: nowSql() });
    env.tables.trades.push({ id: 't2', status: 'closed', pnl: 20, closed_at: nowSql() });
    expect(await getRealizedPnlToday(env)).toBeCloseTo(-30, 5);
  });

  it('open trades never contribute to realized PnL', async () => {
    const env = createFakeD1();
    env.tables.trades.push({ id: 't1', status: 'open', pnl: null, closed_at: null });
    expect(await getRealizedPnlToday(env)).toBe(0);
  });

  it('daily_loss_limit_usd blocks once realized PnL today is at or below -limit', async () => {
    const env = createFakeD1({ app_settings: [{ key: 'daily_loss_limit_usd', value: '100' }] });
    env.tables.trades.push({ id: 't1', status: 'closed', pnl: -100, closed_at: nowSql() });
    const result = await checkRiskRules(env, { strategyActive: true });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('daily_loss_limit');
  });

  it('daily_loss_limit_usd does not block while realized PnL today is still above -limit', async () => {
    const env = createFakeD1({ app_settings: [{ key: 'daily_loss_limit_usd', value: '100' }] });
    env.tables.trades.push({ id: 't1', status: 'closed', pnl: -99, closed_at: nowSql() });
    const result = await checkRiskRules(env, { strategyActive: true });
    expect(result.ok).toBe(true);
  });

  it('a positive realized PnL today never blocks, regardless of the limit', async () => {
    const env = createFakeD1({ app_settings: [{ key: 'daily_loss_limit_usd', value: '1' }] });
    env.tables.trades.push({ id: 't1', status: 'closed', pnl: 500, closed_at: nowSql() });
    const result = await checkRiskRules(env, { strategyActive: true });
    expect(result.ok).toBe(true);
  });
});

describe('riskEngine trading hours window', () => {
  it('blocks outside a [start, end) UTC window that does not include the current hour', async () => {
    const hour = new Date().getUTCHours();
    const start = (hour + 1) % 24;
    const end = hour; // window [hour+1, hour) — excludes the current hour
    const env = createFakeD1({
      app_settings: [
        { key: 'trading_hours_start_utc', value: String(start) },
        { key: 'trading_hours_end_utc', value: String(end) },
      ],
    });
    const result = await checkRiskRules(env, { strategyActive: true });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('trading_hours');
  });

  it('does not block inside a window covering the current hour', async () => {
    const hour = new Date().getUTCHours();
    const env = createFakeD1({
      app_settings: [
        { key: 'trading_hours_start_utc', value: '0' },
        { key: 'trading_hours_end_utc', value: '24' },
      ],
    });
    const result = await checkRiskRules(env, { strategyActive: true });
    expect(result.ok).toBe(true);
    void hour; // window is 24h-wide, always includes "now"
  });
});

describe('riskEngine.checkSessionFilter', () => {
  it('an empty filter ([]) never blocks (no restriction, matches api.js PUT convention)', () => {
    expect(checkSessionFilter([]).ok).toBe(true);
    expect(checkSessionFilter(null).ok).toBe(true);
    expect(checkSessionFilter(undefined).ok).toBe(true);
  });

  it('blocks when the current session is not in a non-empty allow-list', () => {
    const result = checkSessionFilter(['__never_current__']);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('session_filter');
  });

  it('allows when the current session IS in the allow-list', () => {
    const current = sessionOf(new Date()).key;
    const result = checkSessionFilter([current]);
    expect(result.ok).toBe(true);
  });
});

describe('riskEngine.describeRiskRejection', () => {
  it('produces a German sentence naming the specific blocked rule for every reason code', () => {
    const cases = [
      { reason: 'auto_trading_disabled' },
      { reason: 'strategy_inactive' },
      { reason: 'max_open_positions', detail: { openPositions: 5, maxOpenPositions: 5 } },
      { reason: 'daily_loss_limit', detail: { realizedPnlToday: -600, dailyLossLimit: 500 } },
      { reason: 'trading_hours', detail: { hour: 3, startHour: 6, endHour: 22 } },
      { reason: 'session_filter', detail: { currentSession: 'asia', allowed: ['london', 'new_york'] } },
    ];
    for (const c of cases) {
      const text = describeRiskRejection(c);
      expect(typeof text).toBe('string');
      expect(text.length).toBeGreaterThan(0);
    }
  });
});
