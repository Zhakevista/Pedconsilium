/* Педконсилиум — клиент (учитель + родитель). Без библиотек. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const LS = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} },
    del(k) { try { localStorage.removeItem(k); } catch (_) {} },
  };
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  let SUBJECTS = [];
  let TIMER_SEC = 300;
  let clockOffset = 0; // serverNow - Date.now()
  const now = () => Date.now() + clockOffset;

  const people = (n) => n + ' адам';
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const subjName = (key) => {
    const s = SUBJECTS.find((x) => x.key === key);
    return s ? s.name + (s.teacher ? ' · ' + s.teacher : '') : '';
  };
  const mmss = (sec) => {
    sec = Math.max(0, Math.floor(sec));
    return String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0');
  };

  async function api(path, body) {
    const res = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || 'Қате'); e.status = res.status; throw e; }
    if (data.serverNow) clockOffset = data.serverNow - Date.now();
    return data;
  }

  /* ================================================================ */
  /*  ЗВУК                                                             */
  /*  iOS/Android разрешают звук только после касания экрана.           */
  /*  При первом касании «прогреваем» <audio>-элементы и AudioContext,  */
  /*  после этого их можно запускать программно.                        */
  /* ================================================================ */
  const Sound = (() => {
    const files = { notification: '/notification.mp3', warning: '/warning.mp3', bell: '/bell.mp3' };
    const els = {};
    let ctx = null;
    let unlocked = false;
    let pending = null; // звук, который не удалось сыграть (сыграем после касания)

    // iOS 17+: звук Web Audio не глушится переключателем «Без звука»
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (_) {}

    for (const [k, src] of Object.entries(files)) {
      const a = new Audio(src);
      a.preload = 'auto';
      a.setAttribute('playsinline', '');
      els[k] = a;
    }

    function unlock() {
      try {
        if (!ctx) {
          const AC = window.AudioContext || window.webkitAudioContext;
          if (AC) ctx = new AC();
        }
        if (ctx && ctx.state !== 'running') ctx.resume();
        if (ctx) { // короткий беззвучный буфер — разблокирует Web Audio на iOS
          const b = ctx.createBuffer(1, 1, 22050);
          const s = ctx.createBufferSource();
          s.buffer = b; s.connect(ctx.destination); s.start(0);
        }
      } catch (_) {}
      if (unlocked && !pending) return Promise.resolve();
      let okCount = 0;
      const tasks = Object.values(els).map((a) => {
        a.muted = true;
        const p = a.play();
        return (p && p.then ? p : Promise.resolve()).then(() => {
          okCount++; a.pause(); a.currentTime = 0; a.muted = false;
        }).catch(() => { a.muted = false; });
      });
      return Promise.all(tasks).then(() => {
        const was = unlocked;
        unlocked = okCount > 0 || !!(ctx && ctx.state === 'running');
        if (was !== unlocked) document.dispatchEvent(new Event('pk:sound'));
        if (pending) { const p = pending; pending = null; play(p); }
      });
    }

    function synth(kind) {
      if (!ctx) return;
      const t0 = ctx.currentTime + 0.02;
      const tone = (freq, start, dur, vol, type) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = type || 'sine'; o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, t0 + start);
        g.gain.exponentialRampToValueAtTime(vol, t0 + start + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
        o.connect(g); g.connect(ctx.destination);
        o.start(t0 + start); o.stop(t0 + start + dur + 0.05);
      };
      if (kind === 'warning') { tone(880, 0, 0.18, 0.6, 'square'); tone(880, 0.3, 0.18, 0.6, 'square'); }
      else if (kind === 'bell') { for (let i = 0; i < 3; i++) { tone(660, i * 0.9, 1.4, 0.8); tone(1320, i * 0.9, 0.9, 0.3); } }
      else { tone(523, 0, 0.35, 0.7); tone(659, 0.2, 0.35, 0.7); tone(784, 0.4, 0.6, 0.7); }
    }

    function play(kind) {
      if (ctx && ctx.state !== 'running') { try { ctx.resume(); } catch (_) {} }
      const a = els[kind];
      if (!a) return synth(kind);
      try { a.currentTime = 0; } catch (_) {}
      const p = a.play();
      if (p && p.catch) {
        p.catch(() => {
          // mp3 не загрузился или браузер снова требует касания
          if (ctx && ctx.state === 'running') synth(kind);
          else { pending = kind; unlocked = false; document.dispatchEvent(new Event('pk:sound')); }
        });
      }
    }

    return { unlock, play, get unlocked() { return unlocked; } };
  })();

  // Любое касание экрана заново «будит» звук (после блокировки/сворачивания)
  ['pointerdown', 'touchend', 'keydown'].forEach((ev) =>
    document.addEventListener(ev, () => Sound.unlock(), { capture: true, passive: true }));

  /* ================================================================ */
  /*  ЭКРАН НЕ ГАСНЕТ (Screen Wake Lock + запасной видео-трюк)          */
  /*  Пока экран включён и страница открыта — звук и обновления         */
  /*  гарантированно приходят. Это главное решение проблемы iOS/Android. */
  /* ================================================================ */
  const KeepAwake = (() => {
    let lock = null;
    let wanted = false;
    let mode = 'off'; // 'wakelock' | 'video' | 'off'
    const video = $('keepawake');

    async function request() {
      if (!wanted) return;
      if ('wakeLock' in navigator && window.isSecureContext) {
        try {
          lock = await navigator.wakeLock.request('screen');
          mode = 'wakelock';
          lock.addEventListener('release', () => { lock = null; if (mode === 'wakelock') mode = 'off'; emit(); });
          emit();
          return;
        } catch (_) { /* упадём на видео */ }
      }
      try {
        await video.play();
        mode = 'video';
      } catch (_) { mode = 'off'; }
      emit();
    }
    function emit() { document.dispatchEvent(new Event('pk:awake')); }

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && wanted && !lock) request();
    });

    return {
      enable() { wanted = true; request(); },
      disable() {
        wanted = false;
        if (lock) { lock.release().catch(() => {}); lock = null; }
        try { video.pause(); } catch (_) {}
        mode = 'off'; emit();
      },
      get mode() { return mode; },
    };
  })();

  /* ================================================================ */
  /*  Системные уведомления (Android Chrome — когда вкладка в фоне)    */
  /* ================================================================ */
  let swReg = null;
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('/sw.js').then((r) => { swReg = r; }).catch(() => {});
  }
  function askNotifyPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
      try { Notification.requestPermission().then(renderDevice); } catch (_) {}
    }
  }
  function systemNotify(title, body) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if (document.visibilityState === 'visible') return;
    const opts = { body, tag: 'pk-' + title, renotify: true, requireInteraction: true, vibrate: [400, 200, 400, 200, 400] };
    if (swReg && swReg.showNotification) swReg.showNotification(title, opts).catch(() => {});
    else { try { new Notification(title, opts); } catch (_) {} }
  }
  const vibrate = (p) => { try { navigator.vibrate && navigator.vibrate(p); } catch (_) {} };

  /* ================================================================ */
  /*  Связь с сервером в реальном времени (SSE + запасной опрос)        */
  /* ================================================================ */
  const Live = (() => {
    let es = null, query = '', handler = null, pollTimer = null, lastMsg = 0, offlineTimer = null;

    function onData(data) {
      lastMsg = Date.now();
      if (data.serverNow) clockOffset = data.serverNow - Date.now();
      setOffline(false);
      handler && handler(data);
    }
    function setOffline(v) {
      clearTimeout(offlineTimer);
      if (v) offlineTimer = setTimeout(() => $('offline').classList.remove('hidden'), 4000);
      else $('offline').classList.add('hidden');
    }
    function open() {
      if (es) es.close();
      es = new EventSource('/api/stream?' + query);
      es.onmessage = (e) => { try { onData(JSON.parse(e.data)); } catch (_) {} };
      es.onerror = () => setOffline(true);
      es.onopen = () => setOffline(false);
    }
    async function poll() {
      try { onData(await api('/api/state?' + query)); }
      catch (e) { if (e.status === 400 || e.status === 401) handler && handler({ error: 'auth' }); else setOffline(true); }
    }
    // Возвращение на вкладку / разблокировка экрана: мгновенно обновляем данные
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && query) { poll(); if (!es || es.readyState === 2) open(); }
    });
    window.addEventListener('online', () => { if (query) { poll(); open(); } });

    return {
      start(q, h) {
        query = q; handler = h; open(); poll();
        clearInterval(pollTimer);
        pollTimer = setInterval(() => { if (Date.now() - lastMsg > 15000) poll(); }, 5000);
      },
      stop() { query = ''; handler = null; if (es) es.close(); es = null; clearInterval(pollTimer); setOffline(false); },
    };
  })();

  /* ================================================================ */
  /*  Экраны                                                            */
  /* ================================================================ */
  function show(name) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.add('hidden'));
    $('screen-' + name).classList.remove('hidden');
    window.scrollTo(0, 0);
    if (name !== 'parent') setAlert(null);
  }
  document.querySelectorAll('[data-go]').forEach((b) =>
    b.addEventListener('click', () => {
      const to = b.getAttribute('data-go');
      show(to);
      if (to === 'parent-login') setTimeout(() => $('p-name').focus(), 50);
    }));

  function needUnlockOverlay() {
    if (!Sound.unlocked) $('unlock').classList.remove('hidden');
  }
  $('unlock-btn').addEventListener('click', () => {
    Sound.unlock();
    KeepAwake.enable();
    $('unlock').classList.add('hidden');
  });

  /* ================================================================ */
  /*  УЧИТЕЛЬ                                                           */
  /* ================================================================ */
  const T = { token: null, subjectKey: null, view: null, warnedFor: null, belledFor: null, tick: null };

  function renderTeacherSubjects() {
    const box = $('t-subjects');
    box.innerHTML = SUBJECTS.map((s) =>
      `<button class="choice" data-subj="${s.key}" aria-pressed="false">${esc(s.name)}${s.teacher ? `<span class="choice-teacher">${esc(s.teacher)}</span>` : ''}</button>`).join('');
    box.querySelectorAll('.choice').forEach((b) => b.addEventListener('click', () => {
      box.querySelectorAll('.choice').forEach((x) => x.setAttribute('aria-pressed', 'false'));
      b.setAttribute('aria-pressed', 'true');
      T.subjectKey = b.dataset.subj;
      $('t-login-error').textContent = '';
      $('t-pin').focus();
    }));
  }

  async function teacherLogin() {
    Sound.unlock();
    const err = $('t-login-error');
    err.textContent = '';
    if (!T.subjectKey) { err.textContent = 'Пәнді таңдаңыз'; return; }
    try {
      const r = await api('/api/teacher/login', { subject: T.subjectKey, pin: $('t-pin').value.trim() });
      LS.set('pk_teacher', { token: r.token, subject: r.subject.key });
      $('t-pin').value = '';
      enterTeacher(r.token);
    } catch (e) { err.textContent = e.message; }
  }
  $('t-login-btn').addEventListener('click', teacherLogin);
  $('t-pin').addEventListener('keydown', (e) => { if (e.key === 'Enter') teacherLogin(); });

  function enterTeacher(token) {
    T.token = token;
    show('teacher');
    KeepAwake.enable();
    Live.start('token=' + encodeURIComponent(token), (v) => {
      if (v.error) { leaveTeacher(); return; }
      if (v.type !== 'teacher') return;
      renderTeacher(v);
    });
    clearInterval(T.tick);
    T.tick = setInterval(tickTimer, 250);
  }
  function leaveTeacher() {
    Live.stop(); clearInterval(T.tick); KeepAwake.disable();
    LS.del('pk_teacher'); T.token = null; T.view = null;
    show('teacher-login');
  }
  $('t-logout').addEventListener('click', leaveTeacher);

  function renderTeacher(v) {
    const prevStart = T.view && T.view.current ? T.view.current.startedAt : null;
    T.view = v;
    TIMER_SEC = v.timerSec || TIMER_SEC;
    $('t-subject-name').textContent = v.subject.name + (v.subject.teacher ? ' · ' + v.subject.teacher : '');
    $('t-current-name').textContent = v.current ? v.current.name : 'Ешкім жоқ';
    $('t-current-child').textContent = v.current && v.current.child ? 'Баласы: ' + v.current.child : '';

    // Если страница открылась, когда время уже вышло, — не звеним задним числом
    if (v.current && v.current.startedAt !== prevStart) {
      const left = TIMER_SEC - (now() - v.current.startedAt) / 1000;
      T.warnedFor = left <= 60 ? v.current.startedAt : null;
      T.belledFor = left <= 0 ? v.current.startedAt : null;
    }

    const nextEligible = v.queue.find((q) => !q.busyIn);
    $('t-next-name').textContent = nextEligible
      ? '→ ' + nextEligible.name
      : v.queue.length ? (v.current ? 'Қабылдауды аяқтау · күтушілер қазір басқа мұғалімдерде' : 'Күтушілер қазір басқа мұғалімдерде') : (v.current ? 'Кезек бос — қабылдауды аяқтау' : 'Кезек бос');
    $('t-next').disabled = !v.current && !nextEligible;
    $('t-finish').disabled = !v.current;
    $('t-restart').disabled = !v.current;

    $('t-queue-count').textContent = v.queue.length;
    $('t-queue-empty').classList.toggle('hidden', v.queue.length > 0);
    $('t-queue').innerHTML = v.queue.map((q) => {
      const mins = Math.max(0, Math.round((now() - q.joinedAt) / 60000));
      return `<li>
        <div class="q-main">
          <div class="q-name">${esc(q.name)}</div>
          ${q.child ? `<div class="q-child">Баласы: ${esc(q.child)}</div>` : ''}
          <div class="q-meta">${mins} мин күтуде</div>
          ${q.busyIn ? `<span class="q-busy">қазір басқа мұғалімде: ${esc(q.busyIn)}</span>` : ''}
        </div>
        <button class="btn btn-outline q-remove" data-remove="${q.parentId}" aria-label="${esc(q.name)} — кезектен шығару">×</button>
      </li>`;
    }).join('');
    $('t-served').textContent = v.served;
    tickTimer();
  }

  $('t-queue').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-remove]');
    if (!b) return;
    const li = b.closest('li');
    const name = li ? li.querySelector('.q-name').textContent : '';
    if (!confirm('Кезектен шығарасыз ба: ' + name + '?')) return;
    try { renderTeacher(await api('/api/teacher/remove', { token: T.token, parentId: b.dataset.remove })); } catch (_) {}
  });

  function tickTimer() {
    const v = T.view;
    const card = $('t-current');
    if (!v) return;
    card.classList.remove('idle', 'warn', 'over');
    if (!v.current) {
      card.classList.add('idle');
      $('t-timer').textContent = mmss(TIMER_SEC);
      $('t-timer-note').textContent = '«Келесісін шақыру» батырмасын басыңыз';
      return;
    }
    const left = TIMER_SEC - (now() - v.current.startedAt) / 1000;
    if (left > 0) {
      $('t-timer').textContent = mmss(Math.ceil(left));
      if (left <= 60) {
        card.classList.add('warn');
        $('t-timer-note').textContent = '1 минут қалды';
        if (T.warnedFor !== v.current.startedAt) { T.warnedFor = v.current.startedAt; Sound.play('warning'); vibrate(300); }
      } else {
        $('t-timer-note').textContent = '';
      }
    } else {
      card.classList.add('over');
      $('t-timer').textContent = '+' + mmss(-left);
      $('t-timer-note').textContent = 'Уақыт бітті';
      if (T.belledFor !== v.current.startedAt) { T.belledFor = v.current.startedAt; Sound.play('bell'); vibrate([500, 200, 500]); }
    }
  }

  async function teacherAction(path, btn) {
    if (btn) btn.disabled = true;
    try { renderTeacher(await api(path, { token: T.token })); }
    catch (e) { if (e.status === 401) leaveTeacher(); }
    finally { if (btn && T.view) renderTeacher(T.view); }
  }
  $('t-next').addEventListener('click', (e) => teacherAction('/api/teacher/next', e.currentTarget));
  $('t-finish').addEventListener('click', (e) => teacherAction('/api/teacher/finish', e.currentTarget));
  $('t-restart').addEventListener('click', (e) => teacherAction('/api/teacher/restart-timer', e.currentTarget));
  $('t-reset').addEventListener('click', () => {
    if (confirm('«' + (T.view ? T.view.subject.name : '') + '» пәні бойынша бүкіл кезекті тазалайсыз ба?')) teacherAction('/api/teacher/reset');
  });

  /* ================================================================ */
  /*  РОДИТЕЛЬ                                                          */
  /* ================================================================ */
  const P = { me: null, view: null, selected: null, ack: LS.get('pk_ack') || {}, played: LS.get('pk_played') || {}, repeat: null, titleTimer: null };

  async function parentLogin() {
    Sound.unlock();
    KeepAwake.enable();
    const err = $('p-login-error');
    err.textContent = '';
    const name = $('p-name').value.trim().replace(/\s+/g, ' ');
    const child = $('p-child').value.trim().replace(/\s+/g, ' ');
    if (name.length < 2) { err.textContent = 'Атыңызды енгізіңіз'; $('p-name').focus(); return; }
    if (child.length < 2) { err.textContent = 'Баланың аты мен сыныбын енгізіңіз'; $('p-child').focus(); return; }
    try {
      const prev = LS.get('pk_parent');
      const r = await api('/api/parent/login', { name, child, id: prev && prev.id });
      LS.set('pk_parent', r);
      enterParent(r);
    } catch (e) { err.textContent = e.message; }
  }
  $('p-login-btn').addEventListener('click', parentLogin);
  $('p-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('p-child').focus(); });
  $('p-child').addEventListener('keydown', (e) => { if (e.key === 'Enter') parentLogin(); });

  function enterParent(me) {
    P.me = me;
    $('p-me').textContent = me.name;
    $('p-me-child').textContent = me.child ? 'Баласы: ' + me.child : '';
    show('parent');
    KeepAwake.enable();
    Live.start('parentId=' + encodeURIComponent(me.id), (v) => {
      if (v.error) { reloginParent(); return; }
      if (v.type !== 'parent') return;
      renderParent(v);
    });
    renderDevice();
  }
  async function reloginParent() { // сервер перезапускался без данных — регистрируемся заново с тем же id
    const saved = LS.get('pk_parent');
    if (!saved) return;
    try { await api('/api/parent/login', saved); } catch (_) {}
  }
  $('p-logout').addEventListener('click', () => {
    if (!confirm('Шығасыз ба? Кезектегі жазылуларыңыз сақталады — оларға оралу үшін өз атыңызды және баланың атын сол күйінде қайта енгізіңіз.')) return;
    Live.stop(); KeepAwake.disable(); stopCallRepeat(); setAlert(null);
    LS.del('pk_parent'); P.me = null; P.view = null;
    $('p-name').value = ''; $('p-child').value = '';
    show('role');
  });

  function levelOf(r) {
    if (r.status === 'called') return 'called';
    if (r.ahead <= 1) return 'soon';
    return 'wait';
  }

  function renderParent(v) {
    const prevRecords = P.view ? P.view.records : [];
    P.view = v;
    SUBJECTS = v.subjects.map((s) => ({ key: s.key, name: s.name, teacher: s.teacher || '' }));
    const recs = v.records;

    // Новый вызов — автоматически переключаемся на этот предмет
    const newlyCalled = recs.find((r) => r.status === 'called' &&
      !prevRecords.some((p) => p.subject === r.subject && p.status === 'called'));
    if (newlyCalled) P.selected = newlyCalled.subject;
    if (!recs.some((r) => r.subject === P.selected)) P.selected = recs.length ? recs[0].subject : null;

    // --- активные записи (вкладки) ---
    $('p-active-block').classList.toggle('hidden', recs.length === 0);
    $('p-tabs').innerHTML = recs.map((r) => {
      const lvl = levelOf(r);
      const badge = r.status === 'called' ? 'ШАҚЫРУ' : (r.ahead === 0 ? 'келесі — сіз' : 'алдыңызда ' + r.ahead);
      return `<button class="tab" role="tab" data-tab="${r.subject}" aria-selected="${r.subject === P.selected}">
        ${esc(subjName(r.subject))}<span class="badge ${lvl}">${badge}</span></button>`;
    }).join('');

    const sel = recs.find((r) => r.subject === P.selected);
    const card = $('p-status');
    card.className = 'card status-card' + (sel ? ' ' + levelOf(sel) : '');
    if (sel) {
      if (sel.status === 'called') {
        card.innerHTML = `<div class="s-subject">${esc(subjName(sel.subject))}</div>
          <div class="s-ahead s-word">СІЗДІҢ КЕЗЕГІҢІЗ!</div>
          <div class="s-hint">Мұғалім кабинетіне өтіңіз</div>`;
      } else {
        const wait = sel.ahead * Math.round((v.timerSec || 300) / 60);
        card.innerHTML = `<div class="s-subject">${esc(subjName(sel.subject))}</div>
          ${sel.ahead === 0
            ? '<div class="s-ahead s-word">Келесі — сіз</div><div class="s-hint">Мұғалім жақында шақырады — кабинетке жақын болыңыз</div>'
            : `<div class="s-ahead-label">Сіздің алдыңызда:</div>
          <div class="s-ahead">${people(sel.ahead)}</div>
          <div class="s-hint">Күту уақыты ≈ ${wait} мин</div>`}
          <button class="btn" data-leave="${sel.subject}">Жазылудан бас тарту</button>`;
      }
    } else card.innerHTML = '';

    // --- список предметов для записи ---
    $('p-join-title').textContent = recs.length ? 'Тағы бір мұғалімге жазылу' : 'Мұғалімге жазылу';
    $('p-subjects').innerHTML = v.subjects.map((s) => {
      const joined = recs.some((r) => r.subject === s.key);
      const doneHere = v.done.includes(s.key);
      return `<button class="subject-btn ${joined ? 'joined' : ''}" data-subject="${s.key}">
        <span><span class="sb-name">${esc(s.name)}</span><br>${s.teacher ? `<span class="sb-teacher">${esc(s.teacher)}</span><br>` : ''}
        <span class="sb-meta">${s.waiting ? 'кезекте: ' + people(s.waiting) : 'кезек жоқ'}${doneHere && !joined ? ' · сіз болдыңыз ✓' : ''}</span></span>
        <span class="sb-action">${joined ? '✓ Жазылдыңыз' : 'Кезекке тұру →'}</span>
      </button>`;
    }).join('');

    // --- завершённые ---
    const done = v.done.filter((k) => !recs.some((r) => r.subject === k));
    $('p-done-block').classList.toggle('hidden', done.length === 0);
    $('p-done').innerHTML = done.map((k) =>
      `<div class="done-item"><span>✓ ${esc(subjName(k))}</span><button class="btn btn-sm btn-ghost" data-dismiss="${k}">Жасыру</button></div>`).join('');

    handleParentAlerts(recs);
  }

  // Клики в кабинете родителя (делегирование — один обработчик)
  $('screen-parent').addEventListener('click', async (e) => {
    const t = e.target.closest('[data-tab],[data-subject],[data-leave],[data-dismiss]');
    if (!t || !P.me) return;
    if (t.dataset.tab) { P.selected = t.dataset.tab; renderParent(P.view); return; }
    if (t.dataset.subject) {
      const key = t.dataset.subject;
      if (P.view.records.some((r) => r.subject === key)) { P.selected = key; renderParent(P.view); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
      askNotifyPermission();
      t.disabled = true;
      try { P.selected = key; renderParent(await api('/api/parent/join', { parentId: P.me.id, subject: key })); window.scrollTo({ top: 0, behavior: 'smooth' }); }
      catch (_) { t.disabled = false; }
      return;
    }
    if (t.dataset.leave) {
      if (!confirm('Жазылудан бас тартасыз ба: ' + subjName(t.dataset.leave) + '?')) return;
      try { renderParent(await api('/api/parent/leave', { parentId: P.me.id, subject: t.dataset.leave })); } catch (_) {}
      return;
    }
    if (t.dataset.dismiss) {
      try { renderParent(await api('/api/parent/dismiss-done', { parentId: P.me.id, subject: t.dataset.dismiss })); } catch (_) {}
    }
  });

  /* ---- Уведомления родителя: плашка + звук + вибрация ---- */
  function setAlert(kind, html) {
    const a = $('alert');
    if (!kind) { a.className = 'alert hidden'; a.innerHTML = ''; return; }
    a.className = 'alert ' + kind;
    a.innerHTML = html;
  }

  function handleParentAlerts(recs) {
    const called = recs.filter((r) => r.status === 'called');
    const soon = recs.filter((r) => r.status === 'waiting' && r.ahead <= 1);

    // 1) Плашка
    if (called.length) {
      const names = called.map((r) => subjName(r.subject)).join(', ');
      const unacked = called.some((r) => !P.ack[r.subject + '|' + r.since]);
      setAlert('called', `СІЗДІҢ КЕЗЕГІҢІЗ!<small>Мұғалімге өтіңіз: ${esc(names)}</small>` +
        (unacked ? '<button class="btn" id="ack-btn">Барамын ✓</button>' : ''));
      const ack = $('ack-btn');
      if (ack) ack.addEventListener('click', () => {
        called.forEach((r) => { P.ack[r.subject + '|' + r.since] = 1; });
        LS.set('pk_ack', P.ack);
        stopCallRepeat();
        handleParentAlerts(P.view.records);
      });
    } else if (soon.length) {
      const txt = soon.map((r) => subjName(r.subject) + ': ' + (r.ahead ? 'алдыңызда 1 адам' : 'келесі — сіз')).join(' · ');
      setAlert('soon', `КЕЗЕГІҢІЗ ЖАҚЫНДАДЫ!<small>${esc(txt)}</small>`);
    } else setAlert(null);

    // 2) Звук — один раз на каждое новое событие
    let fire = null;
    for (const r of recs) {
      const lvl = levelOf(r);
      if (lvl === 'wait') continue;
      const key = r.subject + '|' + lvl + '|' + r.since;
      if (!P.played[key]) {
        P.played[key] = 1;
        if (lvl === 'called' || !fire) fire = { lvl, r };
      }
    }
    LS.set('pk_played', P.played);
    if (fire) {
      if (fire.lvl === 'called') {
        Sound.play('notification');
        vibrate([600, 200, 600, 200, 600]);
        systemNotify('СІЗДІҢ КЕЗЕГІҢІЗ!', 'Мұғалімге өтіңіз: ' + subjName(fire.r.subject));
      } else {
        Sound.play('warning');
        vibrate([300, 150, 300]);
        systemNotify('Кезегіңіз жақындады', subjName(fire.r.subject) + ': алдыңызда 1 адам');
      }
    }

    // 3) Повтор звука вызова, пока родитель не нажал «Иду ✓» (не более 6 раз)
    const needRepeat = called.some((r) => !P.ack[r.subject + '|' + r.since]);
    if (needRepeat && !P.repeat) {
      let n = 0;
      P.repeat = setInterval(() => {
        if (++n > 6) return stopCallRepeat();
        Sound.play('notification'); vibrate([600, 200, 600]);
      }, 10000);
      startTitleBlink();
    } else if (!needRepeat) stopCallRepeat();
  }
  function stopCallRepeat() {
    clearInterval(P.repeat); P.repeat = null;
    clearInterval(P.titleTimer); P.titleTimer = null; document.title = 'Педконсилиум';
  }
  function startTitleBlink() {
    clearInterval(P.titleTimer);
    let on = false;
    P.titleTimer = setInterval(() => { on = !on; document.title = on ? '🔔 СІЗДІҢ КЕЗЕГІҢІЗ!' : 'Педконсилиум'; }, 1000);
  }

  /* ---- Состояние устройства (звук / экран / уведомления) ---- */
  function renderDevice() {
    const box = $('p-device-status');
    if (!box) return;
    const ok = (t) => `<span class="ok">${t}</span>`;
    const bad = (t) => `<span class="bad">${t}</span>`;
    const lines = [];
    lines.push('Дыбыс: ' + (Sound.unlocked ? ok('қосулы') : bad('қосу үшін экранды басыңыз')));
    const m = KeepAwake.mode;
    lines.push('Экран: ' + (m === 'off' ? bad('сөнуі мүмкін — телефонды бұғаттамаңыз') : ok('бет ашық тұрғанда сөнбейді')));
    if ('Notification' in window) {
      const p = Notification.permission;
      lines.push('Хабарламалар: ' + (p === 'granted' ? ok('қосулы') : p === 'denied' ? bad('браузерде тыйым салынған') : 'жазылғанда сұраймыз'));
    }
    if (isIOS) lines.push('iPhone: дыбыссыз режимді өшіріңіз және бетті жаппаңыз. Жарықтықты азайтуға болады.');
    else lines.push('Бетті жаппаңыз және экранды батырмамен бұғаттамаңыз.');
    box.innerHTML = lines.join('<br>');
  }
  document.addEventListener('pk:sound', renderDevice);
  document.addEventListener('pk:awake', renderDevice);
  $('p-test-sound').addEventListener('click', () => { Sound.unlock().then(() => Sound.play('notification')); vibrate(200); });

  /* ================================================================ */
  /*  Запуск                                                            */
  /* ================================================================ */
  async function boot() {
    try {
      const r = await api('/api/subjects');
      SUBJECTS = r.subjects; TIMER_SEC = r.timerSec;
    } catch (_) {
      SUBJECTS = [];
    }
    renderTeacherSubjects();

    const role = new URLSearchParams(location.search).get('role');
    const teacher = LS.get('pk_teacher');
    const parent = LS.get('pk_parent');

    if (teacher && teacher.token && role !== 'parent') {
      try { await api('/api/state?token=' + encodeURIComponent(teacher.token)); enterTeacher(teacher.token); needUnlockOverlay(); return; }
      catch (e) { if (e.status === 400 || e.status === 401) LS.del('pk_teacher'); }
    }
    if (parent && parent.id && role !== 'teacher') {
      try { const r = await api('/api/parent/login', parent); LS.set('pk_parent', r); enterParent(r); needUnlockOverlay(); return; }
      catch (_) {}
    }
    if (role === 'parent') show('parent-login');
    else if (role === 'teacher') show('teacher-login');
    else show('role');
  }
  boot();
})();
