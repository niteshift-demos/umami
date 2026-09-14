import { saveAuth } from '@/lib/auth';
import { AUTH_TOKEN } from '@/lib/constants';
import { hash, secret } from '@/lib/crypto';
import { createSecureToken } from '@/lib/jwt';
import redis from '@/lib/redis';
import { getUserByUsername } from '@/queries/prisma';

/**
 * Development-only passwordless login.
 *
 * Enabled only when `DEV_LOGIN_USER` names an existing user and the server is
 * not running in production. Signs that user in and redirects to `returnTo`
 * (same-origin paths only). Umami keeps the session token in localStorage, so
 * the response is a tiny page that stores it and then navigates.
 */
export async function GET(request: Request) {
  const username = process.env.DEV_LOGIN_USER;

  if (process.env.NODE_ENV === 'production' || !username) {
    return new Response('Not found', { status: 404 });
  }

  const user = await getUserByUsername(username, { includePassword: true });

  if (!user) {
    return new Response('Not found', { status: 404 });
  }

  const { id, role } = user;
  const pwd = hash(user.password);

  const token = redis.enabled
    ? await saveAuth({ userId: id, role, pwd })
    : createSecureToken({ userId: id, role, pwd }, secret());

  const returnTo = getReturnTo(new URL(request.url).searchParams.get('returnTo'));

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Signing in…</title></head><body><script>
localStorage.setItem(${js(AUTH_TOKEN)}, JSON.stringify(${js(token)}));
window.location.replace(${js(returnTo)});
</script></body></html>`;

  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function js(value: string) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function getReturnTo(value: string | null) {
  const basePath = process.env.BASE_PATH || '';
  let path = '/';

  if (value) {
    try {
      const url = new URL(value, 'http://localhost');
      path = `${url.pathname}${url.search}${url.hash}`;
    } catch {
      path = '/';
    }
  }

  if (!path.startsWith('/') || path.startsWith('//')) {
    path = '/';
  }

  if (basePath && !path.startsWith(`${basePath}/`) && path !== basePath) {
    path = `${basePath}${path}`;
  }

  return path;
}
