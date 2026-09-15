const counters = {
  requests: 0,
  errors: 0,
  byRoute: new Map<string, number>(),
};

export function recordRequest(route: string, failed = false) {
  counters.requests += 1;
  if (failed) counters.errors += 1;
  counters.byRoute.set(route, (counters.byRoute.get(route) ?? 0) + 1);
}

export function readOperationalMetrics() {
  return {
    requests: counters.requests,
    errors: counters.errors,
    byRoute: Object.fromEntries(counters.byRoute.entries()),
  };
}