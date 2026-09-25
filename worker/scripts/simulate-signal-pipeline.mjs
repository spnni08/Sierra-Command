#!/usr/bin/env node
// Dev-only simulation for the 2026-09-25 signal-acceptance/risk-engine
// change — NOT wired into worker-deploy.yml, run manually before merge.
//
// CAVEAT (read before trusting these numbers): this session never had
// credentialed access to the real TradingView-alert log for 17.-25.09 (only
// the aggregate delivered-counts and one representative payload SHAPE per
// strategy, both quoted directly by the user in this conversation) — so
// this is NOT a replay of the actual logged signals. It re-posts the same
// representative fixture (worker/test/fixtures/<id>.payload.json — the
// exact field shape audited against tradingview-bot's current Pine scripts)
// N times per strategy, N = the delivered-count the user reported for that
// strategy. Every repost is therefore structurally/factor-wise identical;
// only two things can still vary run-to-run: (a) the risk engine's
// max-open-positions/daily-loss/trading-hours rules, which accumulate real
// state as the simulated trades "open", and (b) the current wall-clock hour
// (trading-hours rule) and Europe/Berlin session (session-filter rule) at
// the moment this script runs. Strategies with no reported delivered-count
// in this conversation (crypto_baseline, crypto_sr_exclusion,
// crypto_flawless_victory/_v2/_v3, crypto_mfi_engulfing, ict_sweep_mss/_sl,
// sc_keylevel_sweep) are not simulated — there is no count to replay.
//
// Settings used: schema.sql's own seed defaults (app_settings all-default,
// every strategy active=1, session_filter='[]') — this is "the currently
// stored settings" ONLY if nobody has since changed anything via the
// Settings/AutoTrade UI. If they have, re-run this against a real D1 export
// instead (see the README note this script prints at the end).
import { handleWebhookRoute } from '../src/routes/webhook.js';
import { createFakeD1 } from '../test/fakeD1.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, '..', 'test', 'fixtures');

// strategyId -> delivered count, exactly as reported in the 17.-25.09.
// TradingView-alert-log summary this conversation was given.
const DELIVERED_COUNTS = {
  crypto_sr_bollinger: 151,
  crypto_ict_smc: 170,
  crypto_bb_rsi_trendfilter: 91,
  crypto_holy_grail_adx_sma_bb: 49,
  crypto_sr_volume: 20,
  crypto_orderflow_breakout: 133,
  crypto_ichimoku_breakout: 158,
};

function loadFixture(strategyId) {
  return JSON.parse(readFileSync(path.join(fixturesDir, `${strategyId}.payload.json`), 'utf8'));
}

async function postOnce(env, strategyId, payload) {
  const url = new URL(`https://worker.test/webhook/${strategyId}`);
  const request = new Request(url, { method: 'POST', body: JSON.stringify(payload) });
  const res = await handleWebhookRoute(request, url, { DB: env.DB });
  return res.json();
}

async function runSimulation(env) {
  const rows = [];
  for (const [strategyId, count] of Object.entries(DELIVERED_COUNTS)) {
    const payload = loadFixture(strategyId);
    let opened = 0;
    const blockedBy = {};

    for (let i = 0; i < count; i++) {
      const body = (await postOnce(env, strategyId, payload)).data;
      if (body.trade) {
        opened++;
      } else if (body.riskBlocked) {
        blockedBy[body.riskReason] = (blockedBy[body.riskReason] ?? 0) + 1;
      }
      // else: structurally invalid — shouldn't happen for a real fixture,
      // would show up as opened=0 and blockedBy={} with a gap to `count`.
    }

    rows.push({ strategyId, delivered: count, opened, blockedBy });
  }
  return rows;
}

function printRows(rows) {
  const header = ['Strategie', 'zugestellt', 'Trades eröffnet', 'geblockt (Grund: Anzahl)'];
  console.log(header.join(' | '));
  for (const r of rows) {
    const blockedText = Object.entries(r.blockedBy).map(([reason, n]) => `${reason}: ${n}`).join(', ') || '–';
    console.log(`${r.strategyId} | ${r.delivered} | ${r.opened} | ${blockedText}`);
  }
}

async function main() {
  const env = createFakeD1(); // schema.sql's own seed defaults — see header
  const rows = await runSimulation(env);

  console.log('\n=== Lauf 1: Standard-Einstellungen (schema.sql-Defaults, max_open_positions=5) ===\n');
  printRows(rows);

  const totalDelivered = rows.reduce((a, r) => a + r.delivered, 0);
  const totalOpened = rows.reduce((a, r) => a + r.opened, 0);
  console.log(`\nGesamt: ${totalDelivered} zugestellt, ${totalOpened} Trades eröffnet (${((totalOpened / totalDelivered) * 100).toFixed(1)}%).`);
  console.log(`Offene Positionen am Ende der Simulation: ${env.tables.trades.filter((t) => t.status === 'open').length}.`);
  console.log('\n⚠ Wichtige Einschränkung: Diese Simulation schließt nie einen Trade (kein SL/TP-Hit wird nachgebildet —');
  console.log('das wäre echte Kursdaten für den ganzen 9-Tage-Zeitraum, die hier nicht vorliegen). Dadurch füllt sich');
  console.log('max_open_positions realistisch schnell und dominiert danach jede weitere Zeile — das ist ein Artefakt');
  console.log('der Simulation, keine Aussage über die echte Konversionsrate über 9 Tage (in echt schließen Trades');
  console.log('laufend und geben Plätze frei). Aussagekräftig ist trotzdem: mit dem Default-Limit von 5 gleichzeitigen');
  console.log('Positionen reicht bei diesem Signalvolumen (772 in 9 Tagen) EIN einziger aktiver Trade-Cluster, um');
  console.log('praktisch alle folgenden Signale zu blockieren — das Limit müsste ggf. höher gesetzt werden, wenn alle');
  console.log('7 Strategien gleichzeitig aktiv laufen sollen.\n');
  console.log('Hinweis: identische Fixture N-mal wiederholt (s. Kopf-Kommentar dieses Skripts) — kein Replay echter,');
  console.log('unterschiedlicher Signale. Für einen echten Replay: /api/activity-log bzw. /api/trades-Export der echten');
  console.log('Produktions-D1 laden und diesen statt der Fixtures durchlaufen lassen.');

  // Zweiter Lauf: max_open_positions praktisch deaktiviert — isoliert, was
  // die ANDEREN Regeln (Tages-Verlustlimit, Handelszeiten, Session-Filter)
  // und die reine strukturelle Validierung ergeben hätten, ohne dass das
  // Positionslimit (ein Artefakt der "nichts schließt je"-Simulation, s.o.)
  // alles überdeckt.
  const env2 = createFakeD1({ app_settings: [{ key: 'max_open_positions', value: '999999' }] });
  const rows2 = await runSimulation(env2);
  console.log('\n=== Lauf 2: wie Lauf 1, aber max_open_positions praktisch deaktiviert (isoliert die übrigen Regeln) ===\n');
  printRows(rows2);
  const totalOpened2 = rows2.reduce((a, r) => a + r.opened, 0);
  console.log(`\nGesamt (Lauf 2): ${rows2.reduce((a, r) => a + r.delivered, 0)} zugestellt, ${totalOpened2} Trades eröffnet.`);
  console.log('Ohne das Positionslimit wird die Konversionsrate ausschließlich von der strukturellen Validierung');
  console.log('(bekannte Strategie, symbol, direction, price>0, kein is_test) bestimmt — die Faktor-Telemetrie selbst');
  console.log('blockiert nichts mehr (2026-09-25-Entscheidung). Da jede Fixture bereits strukturell gültig ist, öffnet');
  console.log('praktisch jedes Signal einen Trade, bis eine der übrigen Regeln (Tages-Verlustlimit/Handelszeiten/');
  console.log('Session-Filter) im Verlauf der Simulation greift.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
