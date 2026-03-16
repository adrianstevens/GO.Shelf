import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const port = process.env.PORT || 3000;
const host = process.env.HOST || `http://localhost:${port}`;

export default {
  port,
  host,
  downloadDir: process.env.DOWNLOAD_DIR || join(__dirname, 'data', 'downloads'),
  dbPath:      process.env.DB_PATH      || join(__dirname, 'data', 'gog-shelf.db'),
  // Optional HTTP basic auth — set to "username:password" to protect the UI
  basicAuth:   process.env.BASIC_AUTH   || null,
};
