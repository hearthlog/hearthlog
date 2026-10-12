import { describe, expect, it } from 'vitest';
import { countWorkingDays, getCzechHolidayNames, summarizeAnnualEarnings, summarizeWorkingMonth } from './index.js';

describe('flat-rate tax estimate', () => {
    it('applies the 60% allowance, the insurance bases, and the income tax discount', () => {
        const summary = summarizeAnnualEarnings(1_000_000);
        expect(summary.socialInsurance).toBeCloseTo(64_240, 2);
        expect(summary.medicalInsurance).toBeCloseTo(27_000, 2);
        expect(summary.incomeTax).toBeCloseTo(29_160, 2);
        expect(summary.totalTaxes).toBeCloseTo(120_400, 2);
        expect(summary.afterTaxEarnings).toBeCloseTo(879_600, 2);
    });

    it('never lets the discount create a negative income tax or lower the insurance', () => {
        const summary = summarizeAnnualEarnings(10_000);
        expect(summary.incomeTax).toBe(0);
        expect(summary.socialInsurance).toBeGreaterThan(0);
        expect(summarizeAnnualEarnings(-5)).toMatchObject({ totalEarnings: 0, totalTaxes: 0, effectiveRate: 0 });
    });

    it('gives no flat-rate deduction above the tariff cap', () => {
        const summary = summarizeAnnualEarnings(3_000_000);
        expect(summary.incomeTax).toBeCloseTo(239_160, 2);
        expect(summary.totalTaxes).toBeCloseTo(649_740, 2);
    });
});

describe('Czech working days', () => {
    it('knows Easter-based holidays', () => {
        const holidays = getCzechHolidayNames(2026);
        expect(holidays.get('2026-04-03')).toBe('Good Friday');
        expect(holidays.get('2026-04-06')).toBe('Easter Monday');
        expect(holidays.get('2026-12-24')).toBe('Christmas Eve');
    });

    it('counts a month without weekends and weekday holidays', () => {
        expect(countWorkingDays(2026, 3)).toBe(20);
        const summary = summarizeWorkingMonth(2026, 3, '2026-04-15');
        expect(summary).toMatchObject({ workingDays: 20, weekendDays: 8, weekdayHolidays: 2, workingHours: 160 });
        expect(summary.progress).toEqual({ passed: 8, left: 12 });
    });
});
