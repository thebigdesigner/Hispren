/**
 * Transactional outbox — the WRITE side. No Redis, no queue, no imports beyond pg.
 *
 * Modules call publish(tx, ...) INSIDE their withTenant() transaction, so the
 * event is committed atomically with the data change. If the process dies
 * between them, nothing is lost — because there is no "between them".
 *
 * The relay (src/platform/queue.ts) ships these to BullMQ. That half needs
 * Redis. This half does not — which is why the API can run without it.
 */
import { Tx } from "./db";

export type DomainEvent = {
  type: string;          // 'member.registered', 'visitor.registered', ...
  entityType: string;    // 'person'
  entityId?: string;
  payload?: Record<string, unknown>;
};

export async function publish(tx: Tx, e: DomainEvent): Promise<void> {
  await tx.query(
    `INSERT INTO event_outbox (tenant_id, event_type, entity_type, entity_id, payload)
     VALUES (current_tenant_id(), $1, $2, $3, $4)`,
    [e.type, e.entityType, e.entityId ?? null, e.payload ?? {}]
  );
}
