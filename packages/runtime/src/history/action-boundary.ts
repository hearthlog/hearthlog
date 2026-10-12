import { sql, type SqlBool } from 'kysely';

/** A paged download must contain every accepted member before exposing an action. */
export const completeActionBoundary = sql<SqlBool>`(
    raw_events.action_id IS NULL OR (
        raw_events.action_size > 0
        AND raw_events.action_index = raw_events.action_size - 1
        AND (SELECT COUNT(*) FROM raw_events AS member
            WHERE member.tenant_id = raw_events.tenant_id
              AND member.log_id = raw_events.log_id
              AND member.action_id = raw_events.action_id
              AND member.action_size = raw_events.action_size
              AND member.projection_state IN ('effective', 'restored_out')
              AND member.log_version BETWEEN raw_events.log_version - raw_events.action_size + 1 AND raw_events.log_version
              AND member.action_index = member.log_version - (raw_events.log_version - raw_events.action_size + 1)
        ) = raw_events.action_size
    )
)`;
