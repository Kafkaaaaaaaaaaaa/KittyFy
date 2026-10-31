const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const MAX_BYTES = 60 * 1024 * 1024;
const ALLOWED_EXT = new Set(['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.opus', '.flac', '.webm']);
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// rooms: code -> { tracks, index, playing, basePos, serverTime, clients, emptySince }
const rooms = new Map();

const makeCode = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do {
    c = Array.from({ length: 5 }, () => chars[crypto.randomInt(chars.length)]).join('');
  } while (rooms.has(c));
  return c;
};

const getRoom = (code, create = false) => {
  code = String(code || '').toUpperCase();
  if (!/^[A-Z0-9]{3,8}$/.test(code)) return null;
  let r = rooms.get(code);
  if (!r && create) {
    r = { code, tracks: [], index: -1, playing: false, basePos: 0, serverTime: Date.now(), clients: new Set(), emptySince: null };
    rooms.set(code, r);
    fs.mkdirSync(path.join(UPLOAD_DIR, code), { recursive: true });
  }
  return r;
};

const currentPos = (r) => (r.playing ? r.basePos + (Date.now() - r.serverTime) / 1000 : r.basePos);

const publicState = (r) => ({
  t: 'state',
  tracks: r.tracks.map(({ id, name, by, url }) => ({ id, name, by, url: url || null })),
  index: r.index,
  playing: r.playing,
  pos: currentPos(r),
  serverTime: Date.now(),
  listeners: r.clients.size,
});

const broadcast = (r) => {
  const msg = JSON.stringify(publicState(r));
  for (const c of r.clients) if (c.readyState === 1) c.send(msg);
};

const setPos = (r, pos, playing) => {
  r.basePos = Math.max(0, Number(pos) || 0);
  r.serverTime = Date.now();
  if (typeof playing === 'boolean') r.playing = playing;
};

// ---- HTTP ----
app.get('/healthz', (req, res) => res.send('ok'));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/room', (req, res) => {
  const r = getRoom(makeCode(), true);
  res.json({ code: r.code });
});

// Raw upload: POST /api/upload?room=CODE&name=Song.mp3&by=Anas
app.post('/api/upload', express.raw({ type: () => true, limit: MAX_BYTES }), (req, res) => {
  const r = getRoom(req.query.room);
  if (!r) return res.status(404).json({ error: 'room not found' });
  const rawName = String(req.query.name || 'track').slice(0, 200);
  const ext = path.extname(rawName).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) return res.status(400).json({ error: 'unsupported file type' });
  if (!Buffer.isBuffer(req.body) || req.body.length < 100) return res.status(400).json({ error: 'empty file' });
  const id = crypto.randomBytes(6).toString('hex');
  const file = `${id}${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, r.code, file), req.body);
  const name = path.basename(rawName, ext).replace(/[_]+/g, ' ');
  r.tracks.push({ id, file, name, by: String(req.query.by || '').slice(0, 30) });
  if (r.index === -1) { r.index = 0; setPos(r, 0, false); }
  broadcast(r);
  res.json({ ok: true, id });
});

// ---- Free music search (Jamendo, Creative Commons) ----
// Get a free client id at https://devportal.jamendo.com and start with JAMENDO_CLIENT_ID=xxxx
const JAMENDO_ID = process.env.JAMENDO_CLIENT_ID || '';

app.get('/api/search', async (req, res) => {
  if (!JAMENDO_ID) return res.status(503).json({ error: 'no_key' });
  const q = String(req.query.q || '').trim().slice(0, 100);
  if (!q) return res.json({ results: [] });
  try {
    const u = new URL('https://api.jamendo.com/v3.0/tracks/');
    u.search = new URLSearchParams({
      client_id: JAMENDO_ID, format: 'json', limit: '20', search: q,
      audioformat: 'mp32', include: 'musicinfo', imagesize: '100',
    });
    const data = await fetch(u, { signal: AbortSignal.timeout(8000) }).then((r) => r.json());
    const results = (data.results || [])
      .filter((t) => t.audio)
      .map((t) => ({ id: t.id, name: t.name, artist: t.artist_name, image: t.image, duration: t.duration, url: t.audio }));
    res.json({ results });
  } catch (e) {
    res.status(502).json({ error: 'search_failed' });
  }
});

// Add a searched track to the room queue
app.post('/api/add-remote', express.json({ limit: '10kb' }), (req, res) => {
  const r = getRoom(req.query.room);
  if (!r) return res.status(404).json({ error: 'room not found' });
  const { name, artist, url } = req.body || {};
  let host = '';
  try { const u = new URL(url); host = u.protocol === 'https:' ? u.hostname : ''; } catch {}
  if (!host || !(host === 'jamendo.com' || host.endsWith('.jamendo.com'))) return res.status(400).json({ error: 'bad url' });
  const id = crypto.randomBytes(6).toString('hex');
  r.tracks.push({
    id, url, by: String(req.query.by || '').slice(0, 30),
    name: `${String(name || 'Track').slice(0, 100)}${artist ? ' — ' + String(artist).slice(0, 80) : ''}`,
  });
  if (r.index === -1) { r.index = 0; setPos(r, 0, false); }
  broadcast(r);
  res.json({ ok: true, id });
});

// Audio files (express.static handles Range requests so seeking works)
app.get('/audio/:room/:id', (req, res) => {
  const r = getRoom(req.params.room);
  const t = r && r.tracks.find((x) => x.id === req.params.id);
  if (!t || !t.file) return res.sendStatus(404);
  res.sendFile(path.join(UPLOAD_DIR, r.code, t.file));
});

// ---- WebSocket ----
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const r = getRoom(url.searchParams.get('room'));
  if (!r) { ws.close(4004, 'no room'); return; }
  r.clients.add(ws);
  r.emptySince = null;
  broadcast(r);

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    switch (m.t) {
      case 'ping':
        ws.send(JSON.stringify({ t: 'pong', c: m.c, s: Date.now() }));
        return;
      case 'play':
        if (r.index < 0) return;
        setPos(r, m.pos ?? currentPos(r), true);
        break;
      case 'pause':
        setPos(r, m.pos ?? currentPos(r), false);
        break;
      case 'seek':
        setPos(r, m.pos, r.playing);
        break;
      case 'select':
        if (m.index >= 0 && m.index < r.tracks.length) { r.index = m.index; setPos(r, 0, true); }
        break;
      case 'next':
        if (r.tracks.length) { r.index = (r.index + 1) % r.tracks.length; setPos(r, 0, true); }
        break;
      case 'prev':
        if (r.tracks.length) {
          if (currentPos(r) > 3) setPos(r, 0);
          else { r.index = (r.index - 1 + r.tracks.length) % r.tracks.length; setPos(r, 0, true); }
        }
        break;
      case 'ended':
        // Only advance once, even though every client reports it
        if (m.index === r.index && r.tracks.length) {
          if (r.index < r.tracks.length - 1) { r.index += 1; setPos(r, 0, true); }
          else setPos(r, 0, false);
        } else return;
        break;
      case 'remove': {
        const i = r.tracks.findIndex((x) => x.id === m.id);
        if (i === -1) return;
        const [t] = r.tracks.splice(i, 1);
        if (t.file) fs.rm(path.join(UPLOAD_DIR, r.code, t.file), { force: true }, () => {});
        if (!r.tracks.length) { r.index = -1; setPos(r, 0, false); }
        else if (i < r.index) r.index -= 1;
        else if (i === r.index) { r.index = Math.min(i, r.tracks.length - 1); setPos(r, 0, r.playing); }
        break;
      }
      default:
        return;
    }
    broadcast(r);
  });

  ws.on('close', () => {
    r.clients.delete(ws);
    if (!r.clients.size) r.emptySince = Date.now();
    else broadcast(r);
  });
});

// Delete rooms that have been empty for an hour
setInterval(() => {
  for (const [code, r] of rooms) {
    if (!r.clients.size && r.emptySince && Date.now() - r.emptySince > 60 * 60 * 1000) {
      fs.rm(path.join(UPLOAD_DIR, code), { recursive: true, force: true }, () => {});
      rooms.delete(code);
    }
  }
}, 5 * 60 * 1000);

server.listen(PORT, () => console.log(`Duet running on http://localhost:${PORT}`));
