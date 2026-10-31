import assert from "node:assert/strict";
import test from "node:test";

import { platformRangeProblems } from "./check-module.js";

test("a list of platform versions is refused, a range is not", () => {
    assert.deepEqual(platformRangeProblems({ name: "m", peerDependencies: { "@hearthlog/sdk": "^0.10.0" }, devDependencies: { "@hearthlog/sdk": "^0.10.0", vitest: "^4.1.11" } }), []);
    const problems = platformRangeProblems({ name: "m", peerDependencies: { "@hearthlog/sdk": "0.10.0 || 0.10.1" }, devDependencies: { "@hearthlog/tooling": "0.10.0 || 0.10.1", vitest: "^3 || ^4" } });
    assert.equal(problems.length, 2);
    assert.match(problems[0]!, /peerDependencies\.@hearthlog\/sdk/);
});
