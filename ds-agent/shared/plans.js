export const PLANS = {
  free: {
    code: 'free',
    name: 'Free',
    priceInr: 0,
    analysesPerMonth: 10,
    maxFileBytes: 100 * 1024 * 1024,
    description: 'For trying a shared data workspace.',
    features: ['10 analyses per month', '100 MB per dataset', 'EDA reports and visualizations', 'ML baseline comparisons'],
  },
  pro: {
    code: 'pro',
    name: 'Pro',
    priceInr: 999,
    analysesPerMonth: 100,
    maxFileBytes: 100 * 1024 * 1024,
    description: 'For individuals and small teams.',
    features: ['100 analyses per billed seat per month', '100 MB per dataset', 'Workspace members and shared analyses', 'All analysis reports and ML baselines'],
  },
  business: {
    code: 'business',
    name: 'Business',
    priceInr: 2499,
    analysesPerMonth: 500,
    maxFileBytes: 100 * 1024 * 1024,
    description: 'For teams with larger analysis workloads.',
    features: ['500 analyses per billed seat per month', '100 MB per dataset', 'Workspace members and shared analyses', 'All analysis reports and ML baselines'],
  },
};
