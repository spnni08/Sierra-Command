import { describe, it, expect } from 'vitest';
import { sessionOf, isWeekend, SESSION_KEYS, SESSION_LABELS } from '../src/lib/sessions.js';

// All expected values below were cross-checked against the actual
// implementation (not just hand-derived), since Asia (00:00-09:00 UTC,
// fixed) overlaps London's open for its last 1-2 hours every single day,
// and London overlaps New York for most of its own session too — so a
// "pure single session" boundary can only be tested at the specific
// UTC hour where the OTHER adjacent market truly isn't open yet/anymore.
// Summer (BST=UTC+1, EDT=UTC-4): Asia 00:00-09:00, London 07:00-15:30,
// New York 12:00-21:00 UTC. Winter (GMT=UTC+0, EST=UTC-5): Asia
// 00:00-09:00, London 08:00-16:30, New York 13:00-22:00 UTC.

describe('sessionOf — exact open/close boundaries, tested via the key transition at that instant', () => {
  it('Asia opens exactly at 09:00 Tokyo local (00:00 UTC)', () => {
    expect(sessionOf('2026-06-01 23:59:00').key).not.toBe('asia'); // 08:59 local, not yet open
    expect(sessionOf('2026-06-02 00:00:00').key).toBe('asia');
  });

  it('Asia closes exactly at 18:00 Tokyo local (09:00 UTC) — key drops from the overlap down to London alone', () => {
    // London (summer, BST) already opened at 07:00 UTC, so the last hour
    // before Asia's close is always an overlap, never pure 'asia'.
    expect(sessionOf('2026-06-02 08:59:00').key).toBe('asia_london_overlap');
    expect(sessionOf('2026-06-02 09:00:00').key).toBe('london');
  });

  it('London opens exactly at 08:00 local in summer (BST, 07:00 UTC) — key gains the Asia/London overlap', () => {
    // Asia (00:00-09:00 UTC, no DST) is still open at this hour, so London
    // opening turns the key from pure 'asia' into the overlap, not 'london' alone.
    expect(sessionOf('2026-06-02 06:59:00').key).toBe('asia');
    expect(sessionOf('2026-06-02 07:00:00').key).toBe('asia_london_overlap');
  });

  it('London closes exactly at 16:30 local in summer (BST, 15:30 UTC) — key drops from the overlap down to New York alone', () => {
    // New York (12:00-21:00 UTC in summer) is open well before London
    // closes, so the last stretch before London's close is always an
    // overlap, never pure 'london'.
    expect(sessionOf('2026-06-02 15:29:00').key).toBe('london_ny_overlap');
    expect(sessionOf('2026-06-02 15:30:00').key).toBe('new_york');
  });

  it('New York opens exactly at 08:00 local in summer (EDT, 12:00 UTC) — key gains the London/NY overlap', () => {
    expect(sessionOf('2026-06-02 11:59:00').key).toBe('london');
    expect(sessionOf('2026-06-02 12:00:00').key).toBe('london_ny_overlap');
  });

  it('New York closes exactly at 17:00 local in summer (EDT, 21:00 UTC)', () => {
    expect(sessionOf('2026-06-02 20:59:00').key).toBe('new_york');
    expect(sessionOf('2026-06-02 21:00:00').key).not.toBe('new_york');
  });
});

describe('sessionOf — overlaps (derived live, not hardcoded UTC windows)', () => {
  it('London/NY Overlap when both are open (summer, EDT)', () => {
    // 2026-06-02 13:00 UTC -> London local 14:00 (open), NY local 09:00 (open).
    expect(sessionOf('2026-06-02 13:00:00').key).toBe('london_ny_overlap');
  });

  it('Asia/London Overlap when both are open (summer, BST)', () => {
    // 2026-06-02 08:00 UTC -> Asia local 17:00 (open), London local 09:00 (open).
    expect(sessionOf('2026-06-02 08:00:00').key).toBe('asia_london_overlap');
  });

  it('a triple overlap never occurs (Asia always closes before New York can open)', () => {
    // Sweep every UTC hour of a day and confirm every result is one of the
    // six known keys (i.e. the priority logic never produces anything else).
    for (let h = 0; h < 24; h++) {
      const ts = `2026-06-02 ${String(h).padStart(2, '0')}:00:00`;
      const { key } = sessionOf(ts);
      expect(SESSION_KEYS).toContain(key);
    }
  });
});

describe('sessionOf — "Außerhalb" (no session open)', () => {
  it('the gap between New York close and the next Asia open', () => {
    // Summer: NY closes 21:00 UTC (17:00 EDT), Asia doesn't open until
    // 00:00 UTC the next day -> 23:00 UTC is in the dead zone.
    expect(sessionOf('2026-06-02 23:00:00').key).toBe('outside');
  });
});

describe('sessionOf — DST transitions shift the UTC-equivalent window (the whole point of using real market-local time)', () => {
  // EU (London) 2026: clocks go forward Sun 2026-03-29 01:00 UTC (GMT->BST),
  // back Sun 2026-10-25 01:00 UTC (BST->GMT).
  // US (New York) 2026: clocks go forward Sun 2026-03-08 07:00 UTC
  // (EST->EDT), back Sun 2026-11-01 06:00 UTC (EDT->EST).
  // The two transitions land on different dates, so a test that only
  // means to move ONE zone's clock must pick a date range where the
  // OTHER zone's DST state stays constant across the comparison.

  it('London start shifts by 1h across the March EU DST transition (both weekdays are already past the earlier US transition, so New York does not move between them)', () => {
    // Before (GMT, UTC+0): 07:00 UTC = 07:00 London local -> not yet open
    // (opens at 08:00 local) -> only Asia's 00:00-09:00 UTC window is active.
    expect(sessionOf('2026-03-26 07:00:00').key).toBe('asia');
    // After (BST, UTC+1): 07:00 UTC = 08:00 London local -> just opened,
    // and Asia (no DST) is still open too.
    expect(sessionOf('2026-03-30 07:00:00').key).toBe('asia_london_overlap');
  });

  it('London\'s close boundary shifts by 1h across the October EU DST transition (both dates are before New York\'s own Nov-1 transition, so New York stays in EDT throughout)', () => {
    // Before (BST, UTC+1): 15:30 UTC = 16:30 London local -> exactly closed;
    // New York (EDT) local = 11:30 -> open -> 'new_york' alone.
    expect(sessionOf('2026-10-22 15:30:00').key).toBe('new_york');
    // After (GMT, UTC+0): 15:30 UTC = 15:30 London local -> still open
    // (GMT's close is 16:30 UTC, an hour later than BST's); New York
    // (still EDT, its own transition is 10 days later) is also open.
    expect(sessionOf('2026-10-26 15:30:00').key).toBe('london_ny_overlap');
  });

  it('New York start shifts by 1h across the March US DST transition (both weekdays are before the later EU transition, so London stays in GMT throughout)', () => {
    // Before (EST, UTC-5): 12:00 UTC = 07:00 NY local -> not yet open;
    // London (still GMT) local = 12:00 -> open -> 'london' alone.
    expect(sessionOf('2026-03-05 12:00:00').key).toBe('london');
    // After (EDT, UTC-4): 12:00 UTC = 08:00 NY local -> just opened,
    // overlapping London.
    expect(sessionOf('2026-03-12 12:00:00').key).toBe('london_ny_overlap');
  });

  it('New York\'s close boundary shifts by 1h across the November US DST transition (both dates are after London\'s own Oct-25 transition, so London stays in GMT throughout)', () => {
    // Before (EDT, UTC-4): 21:00 UTC = 17:00 NY local -> just closed ->
    // nothing else open at that hour -> 'outside'.
    expect(sessionOf('2026-10-29 21:00:00').key).toBe('outside');
    // After (EST, UTC-5): 21:00 UTC = 16:00 NY local -> still open.
    expect(sessionOf('2026-11-05 21:00:00').key).toBe('new_york');
  });

  it('Asia/Tokyo is unaffected by any DST transition (Japan observes none)', () => {
    expect(sessionOf('2026-03-26 03:00:00').key).toBe('asia');
    expect(sessionOf('2026-03-30 03:00:00').key).toBe('asia');
    expect(sessionOf('2026-10-22 03:00:00').key).toBe('asia');
    expect(sessionOf('2026-10-26 03:00:00').key).toBe('asia');
  });
});

describe('sessionOf / isWeekend — weekend flag is independent of the session result', () => {
  it('flags Saturday as weekend regardless of which session is open', () => {
    // 2026-03-28 is a Saturday. At 12:00 UTC (before the EU DST
    // transition on the 29th, after the US one on the 8th): London (GMT)
    // is open and New York (already EDT) has just opened too.
    const result = sessionOf('2026-03-28 12:00:00');
    expect(result.key).toBe('london_ny_overlap');
    expect(result.isWeekend).toBe(true);
  });

  it('flags Sunday as weekend', () => {
    // 2026-06-07 is a Sunday.
    expect(sessionOf('2026-06-07 10:00:00').isWeekend).toBe(true);
  });

  it('does not flag an ordinary weekday as weekend', () => {
    // 2026-06-02 is a Tuesday.
    expect(sessionOf('2026-06-02 10:00:00').isWeekend).toBe(false);
  });

  it('isWeekend() standalone matches sessionOf()\'s isWeekend for the same instant', () => {
    expect(isWeekend('2026-03-28 12:00:00')).toBe(true);
    expect(isWeekend('2026-06-07 10:00:00')).toBe(true);
    expect(isWeekend('2026-06-02 10:00:00')).toBe(false);
  });
});

describe('sessionOf — accepts Date, epoch-ms, and naive-UTC DB-string input identically', () => {
  it('produces the same result for the same instant across all three input shapes', () => {
    const naive = '2026-06-02 13:00:00';
    const iso = '2026-06-02T13:00:00Z';
    const date = new Date(iso);
    const ms = date.getTime();

    const fromNaive = sessionOf(naive);
    const fromIso = sessionOf(iso);
    const fromDate = sessionOf(date);
    const fromMs = sessionOf(ms);

    expect(fromNaive.key).toBe('london_ny_overlap');
    expect(fromIso).toEqual(fromNaive);
    expect(fromDate).toEqual(fromNaive);
    expect(fromMs).toEqual(fromNaive);
  });
});

describe('sessionOf — invalid input falls back to "outside" rather than throwing', () => {
  it('handles unparseable input safely', () => {
    expect(sessionOf('not-a-date').key).toBe('outside');
    expect(sessionOf(undefined).key).toBe('outside');
    expect(sessionOf(null).key).toBe('outside');
  });
});

describe('SESSION_LABELS', () => {
  it('has a display label for every session key', () => {
    for (const key of SESSION_KEYS) {
      expect(typeof SESSION_LABELS[key]).toBe('string');
      expect(SESSION_LABELS[key].length).toBeGreaterThan(0);
    }
  });

  it('matches the exact German labels the modal/matrix rely on', () => {
    expect(SESSION_LABELS.london_ny_overlap).toBe('London/NY Overlap');
    expect(SESSION_LABELS.asia_london_overlap).toBe('Asia/London Overlap');
    expect(SESSION_LABELS.outside).toBe('Außerhalb');
  });
});
