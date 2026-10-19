import { describe, expect, it } from 'vitest';

import { parseAmount } from './number-format.js';

describe('parseAmount', () => {
    it('reads Czech and plain amounts', () => {
        expect(parseAmount('1 284')).toBe(1284);
        expect(parseAmount('1 284,50')).toBe(1284.5);
        expect(parseAmount('1284.5')).toBe(1284.5);
        expect(parseAmount(',5')).toBe(0.5);
        expect(parseAmount('0')).toBe(0);
    });

    it('adds and subtracts simple sums exactly, to the haléř', () => {
        expect(parseAmount('1200+84')).toBe(1284);
        expect(parseAmount('120 + 85 − 10')).toBe(195);
        expect(parseAmount('0,1+0,2')).toBe(0.3);
        expect(parseAmount('19,99+0,01')).toBe(20);
        expect(parseAmount('100-250')).toBe(-150);
    });

    it('rounds each term half up in decimal', () => {
        expect(parseAmount('1,005')).toBe(1.01);
        expect(parseAmount('1,004')).toBe(1);
        expect(parseAmount('2,675+2,675')).toBe(5.36);
    });

    it('rejects anything that is not a sum of numbers', () => {
        for (const text of ['', ' ', '+', '84+', '1--2', '1,284.50', '12a', '.', '2*3']) {
            expect(parseAmount(text)).toBeNull();
        }
    });
});
