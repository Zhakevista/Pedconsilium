/**
 * «Педконсилиум» — электронная очередь для родительского собрания.
 * Сервер без внешних зависимостей: только встроенные модули Node.js (>= 18).
 * Запуск:  node server.js        (порт: PORT, PIN учителя: PIN, по умолчанию 2026)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const PIN = String(process.env.PIN || '2026');
const TIMER_SEC = Number(process.env.TIMER_SEC) || 300; // 5 минут
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const SUBJECTS = [
  { key: 'hist', name: 'Қазақстан тарихы' },
  { key: 'alg', name: 'Алгебра' },
  { key: 'phys', name: 'Физика' },
  { key: 'inf', name: 'Информатика' },
];
const SUBJECT_BY_KEY = Object.fromEntries(SUBJECTS.map((s) => [s.key, s]));

/* ------------------------------------------------------------------ */
/*  Состояние                                                          */
/* ------------------------------------------------------------------ */

function emptyState() {
  const subjects = {};
  for (const s of SUBJECTS) subjects[s.key] = { current: null, queue: [], served: 0 };
  return { parents: {}, subjects, done: {}, teacherTokens: {} };
}

let state = emptyState();
try {
  const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  state = Object.assign(emptyState(), saved);
  for (const s of SUBJECTS) {
    if (!state.subjects[s.key]) state.subjects[s.key] = { current: null, queue: [], served: 0 };
  }
  console.log('Состояние загружено из', DATA_FILE);
} catch (_) {
  /* файла ещё нет — начинаем с нуля */
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE + '.tmp', JSON.stringify(state), (err) => {
      if (err) return console.error('Не удалось сохранить:', err.message);
      fs.rename(DATA_FILE + '.tmp', DATA_FILE, () => {});
    });
  }, 300);
}

const newId = () => crypto.randomBytes(8).toString('hex');
const normName = (n) => String(n || '').trim().replace(/\s+/g, ' ').toLowerCase();

/** В каком кабинете родитель сейчас на приёме (ключ предмета или null). */
function busyIn(parentId) {
  for (const s of SUBJECTS) {
    const cur = state.subjects[s.key].current;
    if (cur && cur.parentId === parentId) return s.key;
  }
  return null;
}

function finishCurrent(subjKey) {
  const sub = state.subjects[subjKey];
  if (!sub.current) return;
  const pid = sub.current.parentId;
  (state.done[pid] = state.done[pid] || []).push({ subject: subjKey, at: Date.now() });
  sub.served += 1;
  sub.current = null;
}

/* ------------------------------------------------------------------ */
/*  Представления (что видит каждый клиент)                            */
/* ------------------------------------------------------------------ */

function parentView(parentId) {
  const me = state.parents[parentId];
  if (!me) return { type: 'parent', error: 'unknown_parent', serverNow: Date.now() };

  const records = [];
  for (const s of SUBJECTS) {
    const sub = state.subjects[s.key];
    if (sub.current && sub.current.parentId === parentId) {
      records.push({ subject: s.key, status: 'called', ahead: 0, since: sub.current.startedAt });
      continue;
    }
    const idx = sub.queue.findIndex((q) => q.parentId === parentId);
    if (idx !== -1) {
      // Посетитель, который уже сидит в кабинете, тоже считается «перед вами».
      const ahead = idx + (sub.current ? 1 : 0);
      records.push({ subject: s.key, status: 'waiting', ahead, since: sub.queue[idx].joinedAt });
    }
  }
  const done = (state.done[parentId] || []).map((d) => d.subject);

  return {
    type: 'parent',
    serverNow: Date.now(),
    me: { id: me.id, name: me.name, child: me.child || '' },
    subjects: SUBJECTS.map((s) => ({
      key: s.key,
      name: s.name,
      waiting: state.subjects[s.key].queue.length + (state.subjects[s.key].current ? 1 : 0),
    })),
    records,
    done,
    timerSec: TIMER_SEC,
  };
}

function teacherView(subjKey) {
  const sub = state.subjects[subjKey];
  const nameOf = (pid) => (state.parents[pid] ? state.parents[pid].name : '—');
  const childOf = (pid) => (state.parents[pid] && state.parents[pid].child) || '';
  return {
    type: 'teacher',
    serverNow: Date.now(),
    subject: SUBJECT_BY_KEY[subjKey],
    current: sub.current
      ? { parentId: sub.current.parentId, name: nameOf(sub.current.parentId), child: childOf(sub.current.parentId), startedAt: sub.current.startedAt }
      : null,
    queue: sub.queue.map((q) => {
      const b = busyIn(q.parentId);
      return {
        parentId: q.parentId,
        name: nameOf(q.parentId),
        child: childOf(q.parentId),
        joinedAt: q.joinedAt,
        busyIn: b && b !== subjKey ? SUBJECT_BY_KEY[b].name : null,
      };
    }),
    served: sub.served,
    timerSec: TIMER_SEC,
  };
}

/* ------------------------------------------------------------------ */
/*  Реальное время: Server-Sent Events                                 */
/* ------------------------------------------------------------------ */

const clients = new Set(); // { res, parentId?, subject? }

function viewFor(c) {
  return c.subject ? teacherView(c.subject) : parentView(c.parentId);
}

function send(c) {
  try {
    c.res.write('data: ' + JSON.stringify(viewFor(c)) + '\n\n');
  } catch (_) {
    clients.delete(c);
  }
}

let broadcastPending = false;
function broadcast() {
  save();
  if (broadcastPending) return;
  broadcastPending = true;
  setImmediate(() => {
    broadcastPending = false;
    for (const c of clients) send(c);
  });
}

// Пульс: не даёт прокси/хостингу закрыть «молчащее» соединение.
setInterval(() => {
  for (const c of clients) {
    try {
      c.res.write(': ping\n\n');
    } catch (_) {
      clients.delete(c);
    }
  }
}, 20000);

/* ------------------------------------------------------------------ */
/*  HTTP                                                               */
/* ------------------------------------------------------------------ */

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 10000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch (_) {
        resolve({});
      }
    });
  });
}

function teacherSubject(token) {
  return (token && state.teacherTokens[token]) || null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/qr') pathname = '/qr.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(pathname)));
  if (!filePath.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'forbidden' });
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Табылмады');
    }
    const ext = path.extname(filePath).toLowerCase();
    const isMedia = ext === '.mp3' || ext === '.mp4' || ext === '.png';
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': isMedia ? 'public, max-age=86400' : 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

async function handleApi(req, res, url) {
  const p = url.pathname;

  // QR-код (SVG) для плаката. ?url=... — адрес, который нужно закодировать
  if (req.method === 'GET' && p === '/api/qr.svg') {
    const target = String(url.searchParams.get('url') || '').slice(0, 500);
    if (!/^https?:\/\//.test(target)) return json(res, 400, { error: 'bad_url' });
    const QRCode = require('./lib/qrcode');
    const ECL = require('./lib/qrcode/QRErrorCorrectLevel');
    const qr = new QRCode(-1, ECL.M);
    qr.addData(target);
    qr.make();
    const n = qr.getModuleCount();
    const m = 4; // поле вокруг кода
    let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + m} ${r + m}h1v1h-1z`;
    const size = n + m * 2;
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache' });
    return res.end(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">` +
        `<rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`
    );
  }

  if (req.method === 'GET' && p === '/api/subjects') {
    return json(res, 200, { subjects: SUBJECTS, timerSec: TIMER_SEC });
  }

  // Снимок состояния (запасной канал, если поток недоступен)
  if (req.method === 'GET' && p === '/api/state') {
    const subj = teacherSubject(url.searchParams.get('token'));
    if (subj) return json(res, 200, teacherView(subj));
    const pid = url.searchParams.get('parentId');
    if (pid) return json(res, 200, parentView(pid));
    return json(res, 400, { error: 'bad_request' });
  }

  // Поток событий
  if (req.method === 'GET' && p === '/api/stream') {
    const subj = teacherSubject(url.searchParams.get('token'));
    const pid = url.searchParams.get('parentId');
    if (!subj && !pid) return json(res, 400, { error: 'bad_request' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    const c = subj ? { res, subject: subj } : { res, parentId: pid };
    clients.add(c);
    send(c);
    req.on('close', () => clients.delete(c));
    return;
  }

  if (req.method !== 'POST') return json(res, 404, { error: 'not_found' });
  const b = await readBody(req);

  /* ---------- Родитель ---------- */

  if (p === '/api/parent/login') {
    const name = String(b.name || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    const child = String(b.child || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    if (name.length < 3) return json(res, 400, { error: 'Аты-жөніңізді толық енгізіңіз' });
    let parent = b.id && state.parents[b.id];
    if (!parent) {
      // Тот же человек с другого телефона — возвращаем его записи
      parent = Object.values(state.parents).find((x) => normName(x.name) === normName(name));
    }
    if (!parent) {
      const id = typeof b.id === 'string' && /^[a-f0-9]{16}$/.test(b.id) ? b.id : newId();
      parent = state.parents[id] = { id, name, child, createdAt: Date.now() };
    } else {
      parent.name = name;
      if (child) parent.child = child; // при автоматическом повторном входе поле может быть пустым
    }
    broadcast();
    return json(res, 200, { id: parent.id, name: parent.name, child: parent.child || '' });
  }

  if (p === '/api/parent/join') {
    const parent = state.parents[b.parentId];
    const sub = state.subjects[b.subject];
    if (!parent || !sub) return json(res, 400, { error: 'bad_request' });
    const already =
      sub.queue.some((q) => q.parentId === parent.id) || (sub.current && sub.current.parentId === parent.id);
    if (!already) {
      sub.queue.push({ parentId: parent.id, joinedAt: Date.now() });
      // повторная запись к тому же учителю убирает отметку «завершено»
      if (state.done[parent.id]) state.done[parent.id] = state.done[parent.id].filter((d) => d.subject !== b.subject);
      broadcast();
    }
    return json(res, 200, parentView(parent.id));
  }

  if (p === '/api/parent/leave') {
    const sub = state.subjects[b.subject];
    if (!state.parents[b.parentId] || !sub) return json(res, 400, { error: 'bad_request' });
    sub.queue = sub.queue.filter((q) => q.parentId !== b.parentId);
    if (sub.current && sub.current.parentId === b.parentId) sub.current = null;
    broadcast();
    return json(res, 200, parentView(b.parentId));
  }

  if (p === '/api/parent/dismiss-done') {
    if (state.done[b.parentId]) {
      state.done[b.parentId] = state.done[b.parentId].filter((d) => d.subject !== b.subject);
      broadcast();
    }
    return json(res, 200, parentView(b.parentId));
  }

  /* ---------- Учитель ---------- */

  if (p === '/api/teacher/login') {
    if (!SUBJECT_BY_KEY[b.subject]) return json(res, 400, { error: 'Пәнді таңдаңыз' });
    if (String(b.pin || '') !== PIN) return json(res, 401, { error: 'PIN-код қате' });
    const token = newId() + newId();
    state.teacherTokens[token] = b.subject;
    save();
    return json(res, 200, { token, subject: SUBJECT_BY_KEY[b.subject] });
  }

  const subj = teacherSubject(b.token);
  if (p.startsWith('/api/teacher/') && !subj) return json(res, 401, { error: 'Қайта кіріңіз' });
  const sub = subj && state.subjects[subj];

  if (p === '/api/teacher/next') {
    finishCurrent(subj);
    // Первый в очереди, кто не сидит сейчас у другого учителя. Занятые сохраняют место.
    const idx = sub.queue.findIndex((q) => !busyIn(q.parentId));
    if (idx !== -1) {
      const [q] = sub.queue.splice(idx, 1);
      sub.current = { parentId: q.parentId, startedAt: Date.now() };
    }
    broadcast();
    return json(res, 200, Object.assign(teacherView(subj), { invited: idx !== -1 }));
  }

  if (p === '/api/teacher/finish') {
    finishCurrent(subj);
    broadcast();
    return json(res, 200, teacherView(subj));
  }

  if (p === '/api/teacher/restart-timer') {
    if (sub.current) sub.current.startedAt = Date.now();
    broadcast();
    return json(res, 200, teacherView(subj));
  }

  if (p === '/api/teacher/remove') {
    sub.queue = sub.queue.filter((q) => q.parentId !== b.parentId);
    broadcast();
    return json(res, 200, teacherView(subj));
  }

  if (p === '/api/teacher/reset') {
    sub.queue = [];
    sub.current = null;
    sub.served = 0;
    broadcast();
    return json(res, 200, teacherView(subj));
  }

  return json(res, 404, { error: 'not_found' });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((e) => {
      console.error(e);
      json(res, 500, { error: 'server_error' });
    });
  } else if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(req, res, url.pathname);
  } else {
    json(res, 405, { error: 'method_not_allowed' });
  }
});

server.keepAliveTimeout = 65000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Педконсилиум запущен: http://localhost:${PORT}`);
  const nets = require('os').networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) console.log(`  в локальной сети: http://${n.address}:${PORT}`);
    }
  }
});
