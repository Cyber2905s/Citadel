import { HttpError } from './errors.js';

/** @typedef {'owner' | 'admin' | 'member'} Role */

const ALL = ['owner', 'admin', 'member'];
const ADMINS = ['owner', 'admin'];

/** permission -> roles granted it */
export const PERMISSIONS = {
  'org:read': ALL,
  'org:update': ['owner'],
  'members:read': ALL,
  'members:invite': ADMINS,
  'members:update': ['owner'],
  'members:remove': ADMINS,
  'apikeys:manage': ADMINS,
  'audit:read': ADMINS,
  'usage:read': ALL,
  'projects:read': ALL,
  'projects:write': ALL,
  'projects:delete': ADMINS,
};

/** @param {Role} role @param {keyof typeof PERMISSIONS} permission */
export const can = (role, permission) => PERMISSIONS[permission]?.includes(role) ?? false;

/**
 * Route preHandler: 403 unless the caller's role grants `permission`.
 * @param {keyof typeof PERMISSIONS} permission
 */
export const requirePermission = (permission) => async (req) => {
  if (!can(req.auth.role, permission)) {
    throw new HttpError(403, `Role '${req.auth.role}' lacks permission '${permission}'`);
  }
};
