import axios from 'axios';
import { getAccessToken } from './auth.js';

const EMBED_URL = 'https://embed.gog.com';

// Simple in-memory cache: { data, expiresAt }
const cache = { library: null };

async function authHeaders() {
  const token = await getAccessToken();
  return { Authorization: `Bearer ${token}` };
}

export async function getLibrary({ bust = false } = {}) {
  if (!bust && cache.library && Date.now() < cache.library.expiresAt) {
    return cache.library.data;
  }

  const headers = await authHeaders();
  const games = [];
  let page = 1;
  let totalPages = 1;

  do {
    const { data } = await axios.get(`${EMBED_URL}/account/getFilteredProducts`, {
      headers,
      params: { mediaType: 1, page, sortBy: 'title' },
    });
    totalPages = data.totalPages ?? 1;
    if (Array.isArray(data.products)) games.push(...data.products);
    page++;
  } while (page <= totalPages);

  cache.library = { data: games, expiresAt: Date.now() + 5 * 60_000 };
  return games;
}

export async function getGameDetails(gameId) {
  const headers = await authHeaders();
  const { data } = await axios.get(`${EMBED_URL}/account/gameDetails/${gameId}.json`, { headers });
  return data;
}

// Resolve a manualUrl to a direct CDN download URL by following GOG's redirect.
export async function resolveDownloadUrl(manualUrl) {
  const token = await getAccessToken();
  const response = await axios.get(`https://www.gog.com${manualUrl}`, {
    headers: { Authorization: `Bearer ${token}` },
    maxRedirects: 0,
    validateStatus: s => s >= 200 && s < 400,
  });
  return response.headers.location || `https://www.gog.com${manualUrl}`;
}

// Cover image URL from a GOG product image path.
export function coverUrl(imagePath, size = 196) {
  return `https:${imagePath}_${size}.jpg`;
}
