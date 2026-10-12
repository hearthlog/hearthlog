/** Module API v0 for tests: a read session over a test database, and an in-memory projection database. */
export { createReadModelSession, type ReadModelDatabase } from '@hearthlog/runtime/db/read-session.js';
export {
    createProjectionTestDatabase,
    type ProjectionTestDatabase,
    type TestEvent,
    type TestScope,
} from '@hearthlog/runtime/testing/projection-database.js';
