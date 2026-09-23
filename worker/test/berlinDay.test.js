import { describe, it, expect } from 'vitest';
import {
  isValidDateStr,
  berlinDayRangeUtc,
  berlinRangeUtc,
  berlinMonthRangeUtc,
  berlinDateParts,
  berlinDayOfMonth,
} from '../src/lib/berlinDay.js';

describe('isValidDateStr', () => {
  it('accepts well-formed, calendar-valid dates', () => {
    expect(isValidDateStr('2026-09-22')).toBe(true);
    expect(isValidDateStr('2026-01-01')).toBe(true);
    expect(isValidDateStr('2026-12-31')).toBe(true);
    expect(isValidDateStr('2024-02-29')).toBe(true); // leap year
  });

  it('rejects malformed or calendar-invalid dates', () => {
    expect(isValidDateStr('2026-02-30')).toBe(false); // Feb has 28/29 days
    expect(isValidDateStr('2026-13-01')).toBe(false); // no month 13
    expect(isValidDateStr('2026-00-01')).toBe(false); // no month 0
    expect(isValidDateStr('22-09-2026')).toBe(false); // wrong shape
    expect(isValidDateStr('2026/09/22')).toBe(false);
    expect(isValidDateStr('2023-02-29')).toBe(false); // not a leap year
    expect(isValidDateStr(null)).toBe(false);
    expect(isValidDateStr(undefined)).toBe(false);
    expect(isValidDateStr('')).toBe(false);
  });
});

describe('berlinDayRangeUtc', () => {
  it('computes the CEST (+2h, summer) boundary correctly', () => {
    expect(berlinDayRangeUtc('2026-09-22')).toEqual({
      startUtc: '2026-09-21 22:00:00',
      endUtc: '2026-09-22 22:00:00',
    });
  });

  it('computes the CET (+1h, winter) boundary correctly', () => {
    expect(berlinDayRangeUtc('2026-01-15')).toEqual({
      startUtc: '2026-01-14 23:00:00',
      endUtc: '2026-01-15 23:00:00',
    });
  });

  it('rolls over a month boundary correctly', () => {
    // Oct 1st 00:00 Berlin (still CEST, +2h) = Sept 30 22:00 UTC.
    const { endUtc } = berlinDayRangeUtc('2026-09-30');
    expect(endUtc).toBe('2026-09-30 22:00:00');
  });

  it('rolls over a year boundary correctly', () => {
    // Jan 1st 00:00 Berlin (CET, +1h) = Dec 31 23:00 UTC.
    const { endUtc } = berlinDayRangeUtc('2026-12-31');
    expect(endUtc).toBe('2026-12-31 23:00:00');
  });
});

describe('berlinRangeUtc', () => {
  it('spans a multi-day CEST range using the same boundaries as berlinDayRangeUtc', () => {
    expect(berlinRangeUtc('2026-09-01', '2026-09-22')).toEqual({
      startUtc: '2026-08-31 22:00:00',
      endUtc: '2026-09-22 22:00:00',
    });
  });

  it('spans a multi-day CET range', () => {
    expect(berlinRangeUtc('2026-01-10', '2026-01-15')).toEqual({
      startUtc: '2026-01-09 23:00:00',
      endUtc: '2026-01-15 23:00:00',
    });
  });

  it('degenerates to a single-day range when from equals to', () => {
    expect(berlinRangeUtc('2026-09-22', '2026-09-22')).toEqual(berlinDayRangeUtc('2026-09-22'));
  });
});

describe('berlinMonthRangeUtc', () => {
  it('computes the range for a CEST month', () => {
    expect(berlinMonthRangeUtc(2026, 9)).toEqual({
      startUtc: '2026-08-31 22:00:00',
      endUtc: '2026-09-30 22:00:00',
    });
  });

  it('rolls over a year boundary (December -> January)', () => {
    const range = berlinMonthRangeUtc(2026, 12);
    // December start is CET (+1h): 2026-12-01 00:00 Berlin = 2026-11-30 23:00 UTC.
    expect(range.startUtc).toBe('2026-11-30 23:00:00');
    // January 1st 00:00 Berlin (CET, +1h) = Dec 31 23:00 UTC.
    expect(range.endUtc).toBe('2026-12-31 23:00:00');
  });
});

describe('berlinDateParts', () => {
  it('reflects the Berlin calendar day, not the UTC one, near the DST boundary', () => {
    // 23:15 UTC on Sept 22 (CEST, +2h) is already Sept 23 01:15 in Berlin.
    expect(berlinDateParts(new Date('2026-09-22T23:15:00Z'))).toEqual({
      year: 2026, month: 9, day: 23,
    });
    // 21:15 UTC on Sept 22 is still Sept 22 23:15 in Berlin (no shift yet).
    expect(berlinDateParts(new Date('2026-09-22T21:15:00Z'))).toEqual({
      year: 2026, month: 9, day: 22,
    });
  });
});

describe('berlinDayOfMonth', () => {
  it('buckets a naive-UTC DB timestamp into the correct Berlin day', () => {
    // Matches the exact DST-boundary scenario from the investigation: a
    // trade closed_at '2026-09-22 23:15:00' (naive UTC, CEST) is Berlin
    // day 23, not 22 (the bug the old strftime-based bucketing had).
    expect(berlinDayOfMonth('2026-09-22 23:15:00')).toBe(23);
    expect(berlinDayOfMonth('2026-09-22 10:00:00')).toBe(22);
    expect(berlinDayOfMonth('2026-01-15 22:59:00')).toBe(15); // CET: only the last 1h shifts
    expect(berlinDayOfMonth('2026-01-15 23:01:00')).toBe(16);
  });
});
