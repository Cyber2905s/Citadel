-- Sample domain: projects and tasks.

CREATE TABLE projects (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  name         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  UNIQUE (tenant_id, id)
);
CREATE INDEX projects_tenant_id_idx ON projects (tenant_id, id DESC) WHERE deleted_at IS NULL;

CREATE TABLE tasks (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  project_id   uuid NOT NULL,
  title        text NOT NULL,
  status       text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'doing', 'done')),
  assignee_id  uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  -- Composite FK: a task can only point at a project in the *same* tenant.
  -- (FK checks bypass RLS, so a plain FK on project_id would allow cross-tenant links.)
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id)
);
CREATE INDEX tasks_project_idx ON tasks (tenant_id, project_id, id DESC) WHERE deleted_at IS NULL;
