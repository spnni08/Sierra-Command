// Cross-repo contract test: verifies that each strategy's payload schema
// (worker/src/contracts/<id>.schema.json) accurately reflects two things at
// once — (1) the real fixture payload conforms to the schema's required
// base fields, and (2) every field a strategy's factors actually read
// (surfaced via evaluate()'s `missing` result against the fixture) is
// documented in the schema's required/optional lists, so an undocumented
// field reference can never silently exist.
//
// This is the regression guard the 2026-09-25 signal-acceptance change asks
// for: if tradingview-bot's Pine scripts drift again, either the fixture
// stops matching real payloads (caught by re-running this suite after
// updating a fixture — see "Fixtures aktualisieren" in this file's footer
// comment) or a strategy starts reading a field the schema never
// mentioned (caught here automatically, no fixture update needed).
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const contractsDir = path.join(here, '..', 'src', 'contracts');
const fixturesDir = path.join(here, 'fixtures');
const strategiesDir = path.join(here, '..', 'src', 'strategies');

const MODULE_FILE_BY_ID = {
  crypto_baseline: 'cryptoBaseline.js',
  crypto_sr_volume: 'cryptoSrVolume.js',
  crypto_orderflow_breakout: 'cryptoOrderflowBreakout.js',
  crypto_ichimoku_breakout: 'cryptoIchimokuBreakout.js',
  crypto_sr_bollinger: 'cryptoSrBollinger.js',
  crypto_sr_exclusion: 'cryptoSrExclusion.js',
  crypto_ict_smc: 'cryptoIctSmc.js',
  crypto_flawless_victory: 'cryptoFlawlessVictory.js',
  crypto_mfi_engulfing: 'cryptoMfiEngulfing.js',
  crypto_holy_grail_adx_sma_bb: 'cryptoHolyGrailAdxSmaBb.js',
  crypto_bb_rsi_trendfilter: 'cryptoBbRsiTrendfilter.js',
  ict_sweep_mss: 'ictSweepMss.js',
  sc_keylevel_sweep: 'scKeylevelSweep.js',
};

const schemaFiles = readdirSync(contractsDir).filter((f) => f.endsWith('.schema.json'));

describe('payload contracts: fixture <-> schema <-> strategy module', () => {
  for (const file of schemaFiles) {
    const strategyId = file.replace('.schema.json', '');

    describe(strategyId, () => {
      const schema = JSON.parse(readFileSync(path.join(contractsDir, file), 'utf8'));
      const fixturePath = path.join(fixturesDir, `${strategyId}.payload.json`);
      const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

      it('schema.strategyId matches the file name', () => {
        expect(schema.strategyId).toBe(strategyId);
      });

      it('fixture has every required base field, correctly typed', () => {
        // Only symbol/direction/price are truly required — matches
        // webhook.js's checkStructuralValidity exactly (timeframe/is_test
        // are read but never block on absence, see that function; e.g.
        // crypto_baseline.pine's f_payload() never sends is_test at all).
        for (const field of schema.requiredFields) {
          expect(fixture, `fixture missing required field "${field}"`).toHaveProperty(field);
        }
        expect(typeof fixture.symbol).toBe('string');
        expect(['long', 'short']).toContain(String(fixture.direction).toLowerCase());
        expect(Number(fixture.price)).toBeGreaterThan(0);
      });

      it("fixture's is_test, when present, is falsy (a live-signal fixture, not a test one)", () => {
        expect([0, false, undefined]).toContain(fixture.is_test);
      });

      const moduleFile = MODULE_FILE_BY_ID[strategyId];
      if (moduleFile) {
        it("every field the strategy's factors read against the fixture is documented in the schema", async () => {
          const mod = await import(path.join(strategiesDir, moduleFile));
          const result = mod.evaluate(fixture);
          const known = new Set([...schema.requiredFields, ...schema.optionalFields]);
          for (const m of result.missing ?? []) {
            for (const field of m.fields) {
              expect(known.has(field), `factor "${m.name}" reads undocumented field "${field}"`).toBe(true);
            }
          }
        });
      }
    });
  }

  it('every strategy under worker/src/contracts has a matching fixture', () => {
    for (const file of schemaFiles) {
      const strategyId = file.replace('.schema.json', '');
      expect(() => readFileSync(path.join(fixturesDir, `${strategyId}.payload.json`), 'utf8')).not.toThrow();
    }
  });
});

// --- Fixtures aktualisieren, wenn sich ein Pine-Skript ändert -------------
// 1. `spnni08/tradingview-bot`s betroffenes `pinescript/strategies/*.pine`
//    öffnen, die `f_payload()`-Funktion lesen (das ist die vollständige,
//    authoritative Feldliste — nicht raten/aus dem Alert-Log abtippen).
// 2. `worker/test/fixtures/<strategy_id>.payload.json` mit echten,
//    plausiblen Werten für jedes gesendete Feld aktualisieren (direction
//    long ODER short reicht für einen Fixture — beide Richtungen zu pflegen
//    ist nicht nötig, das AND-Gate ist symmetrisch).
// 3. `worker/src/contracts/<strategy_id>.schema.json`s `optionalFields`
//    entsprechend ergänzen/entfernen — jedes von `f_payload()` gesendete
//    Feld gehört hier rein, auch wenn keine Sierra-Command-Factor es liest
//    (Vollständigkeit dokumentiert auch ungenutzte Felder).
// 4. `npx vitest run worker/test/contract.test.js` laufen lassen — schlägt
//    fehl, wenn ein von einem Factor gelesenes Feld nicht im Schema steht.
// 5. Optional, aber empfohlen: den zugehörigen Strategie-Test
//    (`worker/test/*.test.js`, falls vorhanden) mit demselben Fixture
//    erneut laufen lassen, um zu sehen, ob sich `matched`/`failed`/
//    `missing` geändert haben — das zeigt live, ob Pine und Sierra Command
//    (wieder) auseinandergelaufen sind.
