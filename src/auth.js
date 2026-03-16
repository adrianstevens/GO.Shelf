import axios from 'axios';
import { getDb } from './db.js';

const TOKEN_URL    = 'https://auth.gog.com/token';
const clientId     = '46899977096215655';
const clientSecret = '9d85c43b1482497dbbce61f6e4aa173a433796eeae2ca8c5f6129f2dc4de46d9';

// GOG Galaxy's registered redirect URI — the only one accepted by this client ID
const REDIRECT_URI = 'https://embed.gog.com/on_login_success?origin=client';

export function getAuthUrl() {
  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  REDIRECT_URI,
    response_type: 'code',
    layout:        'client2',
  });
  return `https://auth.gog.com/auth?${params}`;
}

export async function exchangeCode(code) {
  try {
    const { data } = await axios.get(TOKEN_URL, {
      params: {
        client_id:     clientId,
        client_secret: clientSecret,
        grant_type:    'authorization_code',
        code,
        redirect_uri:  REDIRECT_URI,
      },
    });
    saveTokens(data);
  } catch (err) {
    const detail = err.response?.data?.error_description || err.response?.data?.error || err.message;
    throw new Error(detail);
  }
}

// Mutex to prevent concurrent token refreshes (e.g. scan + download both hitting an
// expired token at the same moment — the second refresh would use an already-revoked
// refresh_token and fail).
let refreshPromise = null;

export async function getAccessToken() {
  const db  = getDb();
  const row = db.prepare('SELECT * FROM tokens WHERE id = 1').get();

  if (!row) throw new Error('Not authenticated');

  if (Date.now() < row.expires_at - 60_000) {
    return row.access_token;
  }

  // If a refresh is already in flight, wait for it rather than issuing a second one
  if (!refreshPromise) {
    refreshPromise = (async () => {
      try {
        const { data } = await axios.get(TOKEN_URL, {
          params: {
            client_id:     clientId,
            client_secret: clientSecret,
            grant_type:    'refresh_token',
            refresh_token: row.refresh_token,
          },
        });
        saveTokens(data);
        return data.access_token;
      } catch (err) {
        // On a definitive auth rejection, clear tokens so the user is sent back to login
        // rather than looping on every subsequent API call.
        const status = err.response?.status;
        if (status === 400 || status === 401) clearTokens();
        throw err;
      } finally {
        refreshPromise = null;
      }
    })();
  }

  return refreshPromise;
}

export function isAuthenticated() {
  return !!getDb().prepare('SELECT id FROM tokens WHERE id = 1').get();
}

export function clearTokens() {
  getDb().prepare('DELETE FROM tokens WHERE id = 1').run();
}

function saveTokens({ access_token, refresh_token, expires_in }) {
  getDb().prepare(`
    INSERT INTO tokens (id, access_token, refresh_token, expires_at)
    VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      access_token  = excluded.access_token,
      refresh_token = excluded.refresh_token,
      expires_at    = excluded.expires_at
  `).run(access_token, refresh_token, Date.now() + expires_in * 1000);
}
