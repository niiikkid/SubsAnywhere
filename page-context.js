const TRANSIENT_QUERY_KEYS = new Set([
  '_', 'auth', 'authorization', 'exp', 'expires', 'key', 'sig', 'signature',
  't', 'timestamp', 'token',
]);

export function canonicalPageKey(value) {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return `${url.protocol}//${url.host}${url.pathname}${url.search}`;
    const routedHash = /^#(?:!\/|\/)/.test(url.hash) ? url.hash : '';
    url.hash = '';
    for (const name of [...url.searchParams.keys()]) {
      const lower = name.toLowerCase();
      if (TRANSIENT_QUERY_KEYS.has(lower) || lower.startsWith('utm_')) url.searchParams.delete(name);
    }
    const sorted = [...url.searchParams.entries()].sort(([leftName, leftValue], [rightName, rightValue]) => (
      leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue)
    ));
    url.search = new URLSearchParams(sorted).toString();
    url.hash = routedHash;
    return url.href;
  } catch {
    return String(value || 'unknown-page').split('#')[0];
  }
}
