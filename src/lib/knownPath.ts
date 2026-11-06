/**
 * "Page not found" for mistyped addresses (owner, 6 Nov 2026). Before this, a visitor who typed /progams was sent to
 * the sign-in page, because the portal's sign-in guard runs for every address, including ones no page answers.
 *
 * This only decides whether ANY page could answer a GET address. If none could, the visitor gets the 404 page
 * straight away; nothing else runs, so no page is ever served without its sign-in guard. Whenever in doubt (an
 * address with a wildcard or anything unusual), the address counts as known and the request carries on exactly
 * as before.
 */
type RouteInfo = { method: string; path: string };

const esc = (s: string) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');

/** One route pattern as a regular expression; null means "can't tell", which callers treat as known. */
export function routeRegex(path: string): RegExp | null {
  if (!path.startsWith('/')) return null;
  let out = '';
  let i = 0;
  while (i < path.length) {
    const ch = path[i];
    if (ch === ':') {
      // A parameter, with an optional {pattern}: any one segment (looser than the real pattern, so never misses).
      let j = i + 1;
      while (j < path.length && /[A-Za-z0-9_]/.test(path[j])) j++;
      if (path[j] === '{') {
        let depth = 0;
        for (; j < path.length; j++) {
          if (path[j] === '{') depth++;
          else if (path[j] === '}' && --depth === 0) { j++; break; }
        }
      }
      if (path[j] === '?') return null;
      out += '[^/]+';
      i = j;
    } else if (ch === '*') {
      out += '.*';
      i++;
    } else {
      out += esc(ch);
      i++;
    }
  }
  return new RegExp('^' + out.replace(/\/$/, '') + '/?$');
}

/** The route list the site's check was built from (read by the tests). */
export let checkedRoutes: RouteInfo[] = [];

/** Builds the check from the app's own route list. Catch-all middleware ("*" for every method) is left out. */
export function knownPathCheck(routes: RouteInfo[]): (path: string) => boolean {
  checkedRoutes = routes;
  const res: RegExp[] = [];
  let unsure = false;
  for (const r of routes) {
    if (r.method !== 'GET' && r.method !== 'ALL') continue;
    if (r.method === 'ALL' && r.path.endsWith('*')) continue;
    const re = routeRegex(r.path);
    if (!re) unsure = true;
    else res.push(re);
  }
  return (path: string) => unsure || path === '/' || res.some((re) => re.test(path));
}
