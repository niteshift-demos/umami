// Niteshift preview auth: sign in as the default admin user and write Playwright
// storage state. Umami keeps its session token in localStorage (key `umami.auth`),
// so the state carries a localStorage entry for the localhost origin.
import { writeFileSync } from 'node:fs';

const port = process.env.PORT || '3000';
const origin = `http://localhost:${port}`;
const stateFile = process.env.NITESHIFT_AUTH_STATE_FILE;
const username = process.env.UMAMI_DEV_USERNAME || 'admin';
const password = process.env.UMAMI_DEV_PASSWORD || 'umami';

if (!stateFile) {
  console.error('NITESHIFT_AUTH_STATE_FILE is not set');
  process.exit(1);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function login() {
  const res = await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    throw new Error(`login failed: HTTP ${res.status} ${await res.text()}`);
  }
  const { token } = await res.json();
  if (!token) {
    throw new Error('login response had no token');
  }
  return token;
}

let token;
let lastError;
// The dev server may still be compiling when this runs; retry for up to ~3 minutes.
for (let attempt = 0; attempt < 90; attempt++) {
  try {
    token = await login();
    break;
  } catch (e) {
    lastError = e;
    await sleep(2000);
  }
}

if (!token) {
  console.error(`could not sign in to ${origin}: ${lastError?.message}`);
  process.exit(1);
}

const state = {
  cookies: [],
  origins: [
    {
      origin,
      localStorage: [{ name: 'umami.auth', value: JSON.stringify(token) }],
    },
  ],
};

writeFileSync(stateFile, JSON.stringify(state, null, 2));
console.log(`wrote auth state for ${username} at ${origin}`);
