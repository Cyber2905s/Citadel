import { HttpError, notFound } from '../../lib/errors.js';
import { pageOf, pageQuery, toPage } from '../../lib/pagination.js';
import { requirePermission } from '../../lib/rbac.js';
import { audit } from '../audit/service.js';
import { enforceLimit } from '../orgs/routes.js';

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
};

const project = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    description: { type: 'string' },
    created_by: { type: ['string', 'null'] },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
  },
};

const task = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    project_id: { type: 'string' },
    title: { type: 'string' },
    status: { type: 'string' },
    assignee_id: { type: ['string', 'null'] },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
  },
};

const projectBody = {
  name: { type: 'string', minLength: 1, maxLength: 200 },
  description: { type: 'string', maxLength: 5000 },
};
const taskBody = {
  title: { type: 'string', minLength: 1, maxLength: 500 },
  status: { type: 'string', enum: ['todo', 'doing', 'done'] },
  assignee_id: { type: ['string', 'null'], format: 'uuid' },
};

/** users is a global table, so check the assignee actually belongs to this tenant. */
async function assertAssignable(c, userId) {
  if (!userId) return;
  const { rowCount } = await c.query(
    'SELECT 1 FROM memberships WHERE user_id = $1 AND deleted_at IS NULL',
    [userId],
  );
  if (!rowCount) throw new HttpError(400, 'Assignee is not a member of this organization');
}

// Note: no query below filters on tenant_id. RLS adds it; that is the point.

/** @param {import('fastify').FastifyInstance} app */
export async function projectRoutes(app) {
  const read = requirePermission('projects:read');
  const write = requirePermission('projects:write');

  app.get(
    '/',
    {
      preHandler: read,
      schema: {
        tags: ['projects'],
        summary: 'List projects (cursor paginated)',
        querystring: { type: 'object', properties: pageQuery },
        response: { 200: pageOf(project) },
      },
    },
    async (req) => {
      const { limit, cursor } = req.query;
      const { rows } = await req.tx((c) =>
        c.query(
          `SELECT * FROM projects WHERE deleted_at IS NULL AND ($1::uuid IS NULL OR id < $1)
           ORDER BY id DESC LIMIT $2`,
          [cursor ?? null, limit + 1],
        ),
      );
      return toPage(rows, limit);
    },
  );

  app.post(
    '/',
    {
      preHandler: write,
      schema: {
        tags: ['projects'],
        summary: 'Create a project (counts against the plan limit)',
        body: { type: 'object', required: ['name'], properties: projectBody },
        response: { 201: project },
      },
    },
    async (req, reply) => {
      const row = await req.tx(async (c) => {
        const {
          rows: [{ count }],
        } = await c.query('SELECT count(*) FROM projects WHERE deleted_at IS NULL');
        enforceLimit(req.auth.plan, 'maxProjects', Number(count));
        const { rows } = await c.query(
          `INSERT INTO projects (tenant_id, name, description, created_by)
           VALUES (current_tenant_id(), $1, $2, $3) RETURNING *`,
          [req.body.name, req.body.description ?? '', req.auth.userId],
        );
        return rows[0];
      });
      reply.code(201);
      return row;
    },
  );

  app.get(
    '/:id',
    {
      preHandler: read,
      schema: {
        tags: ['projects'],
        summary: 'Get a project',
        params: idParams,
        response: { 200: project },
      },
    },
    async (req) => {
      const { rows } = await req.tx((c) =>
        c.query('SELECT * FROM projects WHERE id = $1 AND deleted_at IS NULL', [req.params.id]),
      );
      if (!rows[0]) throw notFound('Project');
      return rows[0];
    },
  );

  app.patch(
    '/:id',
    {
      preHandler: write,
      schema: {
        tags: ['projects'],
        summary: 'Update a project',
        params: idParams,
        body: { type: 'object', minProperties: 1, properties: projectBody },
        response: { 200: project },
      },
    },
    async (req) => {
      const { rows } = await req.tx((c) =>
        c.query(
          `UPDATE projects SET name = COALESCE($2, name), description = COALESCE($3, description),
             updated_at = now()
           WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
          [req.params.id, req.body.name ?? null, req.body.description ?? null],
        ),
      );
      if (!rows[0]) throw notFound('Project');
      return rows[0];
    },
  );

  app.delete(
    '/:id',
    {
      preHandler: requirePermission('projects:delete'),
      schema: {
        tags: ['projects'],
        summary: 'Soft-delete a project and its tasks',
        params: idParams,
      },
    },
    async (req, reply) => {
      await req.tx(async (c) => {
        const { rows } = await c.query(
          'UPDATE projects SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING name',
          [req.params.id],
        );
        if (!rows[0]) throw notFound('Project');
        await c.query(
          'UPDATE tasks SET deleted_at = now() WHERE project_id = $1 AND deleted_at IS NULL',
          [req.params.id],
        );
        await audit(c, req, 'project.deleted', {
          targetType: 'project',
          targetId: req.params.id,
          metadata: { name: rows[0].name },
        });
      });
      reply.code(204);
    },
  );

  app.get(
    '/:id/tasks',
    {
      preHandler: read,
      schema: {
        tags: ['tasks'],
        summary: "List a project's tasks (cursor paginated)",
        params: idParams,
        querystring: {
          type: 'object',
          properties: { ...pageQuery, status: { type: 'string', enum: ['todo', 'doing', 'done'] } },
        },
        response: { 200: pageOf(task) },
      },
    },
    async (req) => {
      const { limit, cursor, status } = req.query;
      const { rows } = await req.tx((c) =>
        c.query(
          `SELECT * FROM tasks WHERE project_id = $1 AND deleted_at IS NULL
             AND ($2::uuid IS NULL OR id < $2) AND ($3::text IS NULL OR status = $3)
           ORDER BY id DESC LIMIT $4`,
          [req.params.id, cursor ?? null, status ?? null, limit + 1],
        ),
      );
      return toPage(rows, limit);
    },
  );

  app.post(
    '/:id/tasks',
    {
      preHandler: write,
      schema: {
        tags: ['tasks'],
        summary: 'Create a task in a project',
        params: idParams,
        body: { type: 'object', required: ['title'], properties: taskBody },
        response: { 201: task },
      },
    },
    async (req, reply) => {
      const row = await req.tx(async (c) => {
        const { rowCount } = await c.query(
          'SELECT 1 FROM projects WHERE id = $1 AND deleted_at IS NULL',
          [req.params.id],
        );
        if (!rowCount) throw notFound('Project');
        await assertAssignable(c, req.body.assignee_id);
        const { rows } = await c.query(
          `INSERT INTO tasks (tenant_id, project_id, title, status, assignee_id)
           VALUES (current_tenant_id(), $1, $2, $3, $4) RETURNING *`,
          [req.params.id, req.body.title, req.body.status ?? 'todo', req.body.assignee_id ?? null],
        );
        return rows[0];
      });
      reply.code(201);
      return row;
    },
  );
}

/** @param {import('fastify').FastifyInstance} app */
export async function taskRoutes(app) {
  app.patch(
    '/:id',
    {
      preHandler: requirePermission('projects:write'),
      schema: {
        tags: ['tasks'],
        summary: 'Update a task',
        params: idParams,
        body: { type: 'object', minProperties: 1, properties: taskBody },
        response: { 200: task },
      },
    },
    async (req) => {
      const b = req.body;
      const { rows } = await req.tx(async (c) => {
        await assertAssignable(c, b.assignee_id);
        return c.query(
          `UPDATE tasks SET title = COALESCE($2, title), status = COALESCE($3, status),
             assignee_id = CASE WHEN $4 THEN $5::uuid ELSE assignee_id END, updated_at = now()
           WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
          [
            req.params.id,
            b.title ?? null,
            b.status ?? null,
            'assignee_id' in b,
            b.assignee_id ?? null,
          ],
        );
      });
      if (!rows[0]) throw notFound('Task');
      return rows[0];
    },
  );

  app.delete(
    '/:id',
    {
      preHandler: requirePermission('projects:delete'),
      schema: { tags: ['tasks'], summary: 'Soft-delete a task', params: idParams },
    },
    async (req, reply) => {
      await req.tx(async (c) => {
        const { rows } = await c.query(
          'UPDATE tasks SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING title',
          [req.params.id],
        );
        if (!rows[0]) throw notFound('Task');
        await audit(c, req, 'task.deleted', {
          targetType: 'task',
          targetId: req.params.id,
          metadata: { title: rows[0].title },
        });
      });
      reply.code(204);
    },
  );
}
