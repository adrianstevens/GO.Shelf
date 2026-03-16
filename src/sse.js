// Shared SSE broadcast — all clients connect to /api/events and receive
// events from both the downloader and the scanner.

const clients = new Set();

export function addClient(res) {
  clients.add(res);
  res.on('close', () => clients.delete(res));
}

export function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) {
    try {
      c.write(msg);
    } catch {
      // Socket already closed — remove so we don't keep trying
      clients.delete(c);
    }
  }
}
