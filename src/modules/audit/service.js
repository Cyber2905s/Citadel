/**
 * Records a sensitive action. Call with the same client as the change itself so
 * the audit row commits (or rolls back) atomically with it.
 * @param {import('pg').PoolClient} client
 * @param {import('fastify').FastifyRequest} req
 * @param {string} action e.g. 'member.removed'
 * @param {{ targetType?: string, targetId?: string, metadata?: object }} [details]
 */
export async function audit(client, req, action, { targetType, targetId, metadata = {} } = {}) {
  await client.query(
    `INSERT INTO audit_logs (tenant_id, actor_type, actor_id, action, target_type, target_id, metadata, ip, request_id)
     VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      req.auth?.actorType ?? 'user',
      req.auth?.actorId ?? null,
      action,
      targetType ?? null,
      targetId ?? null,
      metadata,
      req.ip,
      req.id,
    ],
  );
}
