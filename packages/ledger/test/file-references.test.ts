import { describe, expect, it } from "vitest";

import { fileReference, validateIncomingEvent } from "../src/domain";
import type { FileReference } from "#generated/event-schemas";
import type { IncomingEvent } from "../src/schemas";

// A made-up module's file-bearing entity, so the rule is shown without naming any real one.
const REFERENCES: Record<string, FileReference> = {
    TEST_DOC_ADDED: { entity: "test_doc", versionKey: "fileVersionId", requiredOnAdd: true },
    TEST_DOC_UPDATED: { entity: "test_doc", versionKey: "fileVersionId", requiredOnAdd: false },
};
const DOC = "11111111-1111-4111-8111-111111111111";
const VERSION = "22222222-2222-4222-8222-222222222222";
const event = (type: string, payload: Record<string, unknown>, entityId = `test_doc:${DOC}`): IncomingEvent =>
    ({ type, entityId, payload } as IncomingEvent);

describe("file references declared by entity definitions", () => {
    it("grants the named version on an add and on an update that replaces the file", () => {
        expect(fileReference(event("TEST_DOC_ADDED", { id: DOC, fileVersionId: VERSION }), REFERENCES)).toEqual({ ownerId: DOC, fileVersionId: VERSION });
        expect(fileReference(event("TEST_DOC_UPDATED", { id: DOC, fileVersionId: VERSION }), REFERENCES)).toEqual({ ownerId: DOC, fileVersionId: VERSION });
    });

    it("ignores an update that keeps the file, and events of other entities", () => {
        expect(fileReference(event("TEST_DOC_UPDATED", { id: DOC, caption: "x" }), REFERENCES)).toBeNull();
        expect(fileReference(event("OTHER_ADDED", { id: DOC }, `other:${DOC}`), REFERENCES)).toBeNull();
    });

    it("rejects an add without a version, ids that are not UUIDs, and an entityId that does not match the payload", () => {
        expect(() => validateIncomingEvent(event("TEST_DOC_ADDED", { id: DOC }), REFERENCES)).toThrow(/requires UUID id and fileVersionId/);
        expect(() => validateIncomingEvent(event("TEST_DOC_ADDED", { id: "not-a-uuid", fileVersionId: VERSION }), REFERENCES)).toThrow(/requires UUID/);
        expect(() => validateIncomingEvent(event("TEST_DOC_UPDATED", { id: DOC, fileVersionId: "x" }), REFERENCES)).toThrow(/requires UUID/);
        expect(() => validateIncomingEvent(event("TEST_DOC_ADDED", { id: DOC, fileVersionId: VERSION }, "test_doc:other"), REFERENCES)).toThrow(/entityId must match/);
    });
});
