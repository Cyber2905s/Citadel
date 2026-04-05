/** Plan tiers. null = unlimited. */
export const PLANS = {
  free: { requestsPerMinute: 60, maxProjects: 3, maxMembers: 3, maxApiKeys: 1 },
  pro: { requestsPerMinute: 600, maxProjects: 100, maxMembers: 25, maxApiKeys: 10 },
  enterprise: { requestsPerMinute: 6000, maxProjects: null, maxMembers: null, maxApiKeys: null },
};
