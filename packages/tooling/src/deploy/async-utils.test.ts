import assert from "node:assert/strict";
import test from "node:test";

import {
    mapWithConcurrency,
    parseConcurrency,
    settleWithConcurrency,
} from "./async-utils.js";

test("maps with bounded concurrency and preserves input order", async () => {
    let active = 0;
    let peak = 0;
    const values = await mapWithConcurrency([1, 2, 3, 4], 2, async (value) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return value * 2;
    });

    assert.deepEqual(values, [2, 4, 6, 8]);
    assert.equal(peak, 2);
});

test("settles every item even when one task fails", async () => {
    const results = await settleWithConcurrency([1, 2, 3], 2, async (value) => {
        if (value === 2) throw new Error("expected failure");
    });

    assert.deepEqual(
        results.map((result) => result.status),
        ["fulfilled", "rejected", "fulfilled"],
    );
});

test("validates an explicit concurrency value", () => {
    assert.equal(parseConcurrency("3", 1), 3);
    assert.equal(parseConcurrency(undefined, 2), 2);
    assert.throws(() => parseConcurrency("0"), /between 1 and 32/);
    assert.throws(() => parseConcurrency("many"), /between 1 and 32/);
});
