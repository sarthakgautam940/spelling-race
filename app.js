(function () {
  'use strict';

  const ROOM = '91409';
  const HOST_ID = 'spellrace-room-' + ROOM + '-v1';
  const COUNT_MS = 3000, RESULT_MS = 3800, NOWIN_MS = 3000;
  const E = window.Engine;
  const $ = (id) => document.getElementById(id);
  const qs = new URLSearchParams(location.search);
  const peerOpts = { debug: 0 };
  if (qs.get('peer')) { // local testing hook
    const [h, p] = qs.get('peer').split(':');
    Object.assign(peerOpts, { host: h, port: +p, path: '/', secure: false, config: { iceServers: [] } });
  }

  /* ---------- small helpers ---------- */
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }
  };
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const fmt = (ms) => (ms / 1000).toFixed(2) + ' s';
  const rand = (n) => Math.floor(Math.random() * n);
  const loadScript = (src) => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.async = true; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
  let depsP = null;
  const ensureDeps = () => depsP || (depsP = Promise.all([
    window.Peer ? 0 : loadScript('vendor/peerjs.min.js'),
    window.WORDS ? 0 : loadScript('words.js')
  ]).catch((e) => { depsP = null; throw e; }));

  /* ---------- sound ---------- */
  const Snd = {
    on: store.get('sr-sound') !== 'off', ctx: null,
    init() { if (!this.ctx) { try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) {} } if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); },
    beep(f, d, type, g, delay) {
      if (!this.on || !this.ctx) return;
      const c = this.ctx, t = c.currentTime + (delay || 0), o = c.createOscillator(), v = c.createGain();
      o.type = type || 'sine'; o.frequency.value = f;
      v.gain.setValueAtTime(0.0001, t); v.gain.exponentialRampToValueAtTime(g || 0.12, t + 0.01); v.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(v); v.connect(c.destination); o.start(t); o.stop(t + d + 0.02);
    },
    tick() { this.beep(520, 0.07); },
    go() { this.beep(880, 0.16, 'triangle', 0.16); },
    win() { [523, 659, 784, 1047].forEach((f, i) => this.beep(f, 0.18, 'triangle', 0.14, i * 0.08)); },
    lose() { this.beep(294, 0.2, 'sine', 0.12); this.beep(220, 0.3, 'sine', 0.12, 0.14); },
    wrong() { this.beep(180, 0.14, 'square', 0.05); },
    done() { this.beep(660, 0.08, 'triangle', 0.1); this.beep(990, 0.12, 'triangle', 0.1, 0.07); }
  };

  /* ---------- state ---------- */
  let net = null, me = '', role = null, S = null, A = null, R = null, lastState = null;
  let inRoom = false, lastResultN = 0, banner = '', resetArm = 0, oppProg = 0;
  const T = window.Timers;

  const newState = () => ({ v: 0, phase: 'wait', settings: { mode: 'copy', level: 'ramp' }, players: {}, order: [], round: null, result: null, history: [], pauseNext: false, pausedWhy: null, roundN: 0, rampN: 0 });
  const newPlayer = (name) => ({ name, wins: 0, streak: 0, bestStreak: 0, connected: true, ready: false, rounds: 0, correct: 0, precSum: 0, precN: 0, msSum: 0, bestMs: null, chars: 0, letters: {} });
  const guestName = () => (S ? S.order.find((k) => k !== me) : null);

  /* ---------- views ---------- */
  const views = ['v-home', 'v-code', 'v-name', 'v-room'];
  function show(id) { views.forEach((v) => $(v).classList.toggle('hidden', v !== id)); inRoom = id === 'v-room'; window.scrollTo(0, 0); }
  const panes = ['st-wait', 'st-ready', 'st-count', 'st-live', 'st-result', 'st-paused'];
  let curPane = '';
  function pane(id) { if (curPane === id) return; curPane = id; panes.forEach((p) => $(p).classList.toggle('hidden', p !== id)); }

  $('joinBtn').onclick = () => { Snd.init(); ensureDeps().catch(() => {}); show('v-code'); $('codeInput').value = ''; $('codeErr').textContent = ''; setTimeout(() => $('codeInput').focus(), 30); };
  document.querySelectorAll('[data-back]').forEach((b) => (b.onclick = () => show('v-' + b.dataset.back)));
  $('codeInput').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 5); $('codeErr').textContent = ''; });
  $('codeForm').onsubmit = (e) => {
    e.preventDefault();
    const c = $('codeInput').value.trim();
    if (c !== ROOM) { $('codeErr').textContent = c.length < 5 ? 'Enter the 5 digit code.' : 'No room with that code.'; return; }
    show('v-name'); $('nameErr').textContent = '';
    const n = $('nameInput'); n.value = store.get('sr-name') || ''; setTimeout(() => n.focus(), 30);
  };
  $('nameForm').onsubmit = (e) => {
    e.preventDefault();
    const n = $('nameInput').value.replace(/\s+/g, ' ').trim();
    if (!n) { $('nameErr').textContent = 'Type a name first.'; return; }
    Snd.init(); store.set('sr-name', n); startRoom(n);
  };

  /* ---------- connect ---------- */
  async function startRoom(name) {
    me = name; role = null; S = null; R = null; lastState = null; lastResultN = 0; oppProg = 0; curPane = '';
    show('v-room'); setBanner('Connecting', false); render();
    try { await ensureDeps(); } catch (_) { setBanner('Could not load the game files. Check your connection and reload.', true); return; }
    net = window.Net({
      hostId: HOST_ID, name, peerOpts,
      on: {
        status(s) { if (s === 'connecting' && !role) setBanner('Connecting', false); else if (s === 'offline') setBanner('Cannot reach the matchmaking server. Retrying', true); else if (s === 'online') setBanner('', false); },
        role(r) { role = r; if (r === 'host') initHost(); },
        welcome(m) { if (m.name) me = m.name; },
        hello: onHello,
        msg: onMsg,
        guestLeft: onGuestLeft,
        hostLost() { lastState = S; S = null; R = null; role = null; setBanner('Host left. Reconnecting', false); render(); },
        rejected(why) {
          net = null; show('v-name');
          $('nameErr').textContent = why === 'full' ? 'The room is full right now.' : 'That name is taken in the room. Pick another.';
        },
        rtt() { renderNet(); }
      }
    });
    net.start();
  }

  function leave() {
    if (net) { net.stop(); net = null; }
    S = null; R = null; A = null; role = null; lastState = null;
    try { speechSynthesis.cancel(); } catch (_) {}
    show('v-home');
  }
  $('leaveBtn').onclick = leave;
  window.addEventListener('pagehide', () => { if (net) net.stop(); });

  function setBanner(text, bad) { banner = text; const b = $('banner'); b.textContent = text; b.classList.toggle('hidden', !text); b.classList.toggle('bad', !!bad); }

  /* ---------- host: lobby ---------- */
  function initHost() {
    A = { answer: null, attempts: {}, live: {}, used: new Set(), t: {}, idle: 0, wordSet: null };
    if (lastState) {
      S = lastState; lastState = null;
      S.phase = 'wait'; S.round = null; S.result = null; S.pauseNext = false; S.pausedWhy = null;
      for (const k of S.order) { S.players[k].connected = false; S.players[k].ready = false; }
    } else S = newState();
    addPlayer(me);
    maybeLobby(); setBanner('', false); bump();
  }
  function addPlayer(name) {
    if (!S.players[name]) S.players[name] = newPlayer(name);
    S.players[name].connected = true; S.players[name].ready = false;
    if (!S.order.includes(name)) S.order.push(name);
  }
  const connCount = () => S.order.filter((k) => S.players[k].connected).length;
  function clearTimers() { for (const k of Object.keys(A.t)) { T.clear(A.t[k]); delete A.t[k]; } }
  function maybeLobby() {
    if (connCount() < 2) {
      if (S.phase !== 'wait') { clearTimers(); S.phase = 'wait'; S.round = null; S.result = null; S.pauseNext = false; S.pausedWhy = null; }
      S.order.forEach((k) => (S.players[k].ready = false));
    } else if (S.phase === 'wait') {
      S.phase = 'ready'; S.order.forEach((k) => (S.players[k].ready = false));
    }
  }
  function onHello(m, accept) {
    if (!S) return accept(false, 'full');
    const name = String(m.name || '').replace(/\s+/g, ' ').trim().slice(0, 14);
    if (!name) return accept(false, 'name');
    const key = S.order.find((k) => k.toLowerCase() === name.toLowerCase());
    if (key) {
      if (S.players[key].connected) return accept(false, 'name');
      S.players[key].connected = true; S.players[key].ready = false;
      accept(true, null, { name: key });
    } else if (S.order.length < 2) {
      addPlayer(name); accept(true, null, { name });
    } else {
      const stale = S.order.find((k) => !S.players[k].connected);
      if (!stale) return accept(false, 'full');
      delete S.players[stale]; S.order = S.order.filter((k) => k !== stale);
      addPlayer(name); accept(true, null, { name });
    }
    maybeLobby(); bump();
  }
  function onGuestLeft() {
    if (!S) return;
    const g = guestName();
    if (g && S.players[g]) { S.players[g].connected = false; S.players[g].ready = false; }
    oppProg = 0; maybeLobby(); bump();
  }

  /* ---------- message routing ---------- */
  function onMsg(m) {
    if (role === 'host') {
      if (m.t === 'prog') { recordLive(guestName(), m); if (R && m.n === R.n) { oppProg = m.p || 0; paintOppProg(); } return; }
      hostHandle(guestName(), m);
    } else {
      if (m.t === 'state') { S = m.s; applyState(); }
      else if (m.t === 'prog') { if (R && m.n === R.n) { oppProg = m.p || 0; paintOppProg(); } }
    }
  }
  function act(m) { if (role === 'host') hostHandle(me, m); else if (net) net.send(m); }

  function hostHandle(from, m) {
    if (!S || !from || !S.players[from]) return;
    const p = S.players[from];
    switch (m.t) {
      case 'ready':
        if (S.phase !== 'ready') return;
        p.ready = !!m.v;
        if (S.order.every((k) => S.players[k].ready && S.players[k].connected)) startRound(); else bump();
        break;
      case 'set':
        if (m.k === 'mode' && ['copy', 'fix', 'hear'].includes(m.v)) S.settings.mode = m.v;
        else if (m.k === 'level' && ['ramp', 'easy', 'medium', 'hard'].includes(m.v)) S.settings.level = m.v;
        else return;
        bump(); break;
      case 'pause':
        if (S.phase === 'round' || S.phase === 'result') { S.pauseNext = !S.pauseNext; bump(); }
        break;
      case 'resume':
        if (S.phase === 'paused') startRound();
        break;
      case 'reset':
        clearTimers();
        S.order.forEach((k) => { const c = S.players[k].connected; S.players[k] = newPlayer(k); S.players[k].connected = c; });
        S.history = []; S.rampN = 0; S.round = null; S.result = null; S.pauseNext = false; S.pausedWhy = null; S.phase = 'wait'; A.used.clear(); A.idle = 0;
        maybeLobby(); R = null; bump(); break;
      case 'sub': onSub(from, m); break;
    }
  }

  /* ---------- host: rounds ---------- */
  const FALLBACK = 'planet silver rocket garden window bridge castle pencil orange thunder monkey whisper puzzle jungle ladder'.split(' ');
  function pickRound(mode, level, n) {
    const W = window.WORDS || { easy: FALLBACK, medium: FALLBACK, hard: FALLBACK };
    const w = E.levelWeights(level, n);
    let tier = 'easy', r = Math.random() * (w.easy + w.medium + w.hard);
    if (r < w.easy) tier = 'easy'; else if (r < w.easy + w.medium) tier = 'medium'; else tier = 'hard';
    const pool = W[tier];
    let word = null;
    for (let i = 0; i < 80 && !word; i++) {
      const c = pool[rand(pool.length)];
      if (A.used.has(c)) continue;
      if (mode === 'hear' && E.HOMOPHONES.has(c)) continue;
      word = c;
    }
    if (!word) { A.used.clear(); word = pool[rand(pool.length)]; }
    A.used.add(word);
    let shown = word;
    if (mode === 'fix') {
      if (!A.wordSet) A.wordSet = new Set([].concat(W.easy, W.medium, W.hard));
      shown = E.misspell(word, (x) => A.wordSet.has(x)).shown;
    }
    return { word, shown };
  }

  function startRound() {
    clearTimers();
    S.roundN++; S.rampN++;
    const mode = S.settings.mode;
    const { word, shown } = pickRound(mode, S.settings.level, S.rampN);
    const len = word.length;
    const limit = Math.min(30000, 9000 + len * 1200 + (mode === 'copy' ? 0 : 3000));
    A.answer = word; A.attempts = {}; A.live = {};
    S.round = { n: S.roundN, mode, shown: mode === 'hear' ? null : shown, len, say: mode === 'hear' ? word : null, startAt: net.hostNow() + COUNT_MS, limit, locked: [] };
    S.result = null; S.phase = 'round'; S.pausedWhy = null;
    S.order.forEach((k) => (S.players[k].ready = false));
    A.t.end = T.after(COUNT_MS + limit, finish);
    bump();
  }

  function recordLive(name, m) {
    if (!A || !name || !S || !S.round || m.n !== S.round.n) return;
    A.live[name] = { k: m.k | 0, e: m.e | 0, l: String(m.l || '').slice(0, 60), p: m.p || 0 };
  }

  function onSub(name, m) {
    if (S.phase !== 'round' || !S.round || m.n !== S.round.n || A.attempts[name]) return;
    const text = String(m.text || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 40);
    const ms = Math.max(0, Number(m.ms) || 0);
    const ok = text === A.answer;
    A.attempts[name] = { text, ms, ok, keys: m.keys | 0, errs: m.errs | 0, el: String(m.el || '').slice(0, 60), at: performance.now() };
    const other = S.order.find((k) => k !== name);
    const oa = other && A.attempts[other];
    if (!ok) S.round.locked.push(name);
    if (ok) {
      if (oa) { finish(); return; }
      if (S.players[other] && !S.players[other].connected) { finish(); return; }
      if (!A.t.grace) {
        const rtt = net.peerRtt || 60;
        const g = name === me ? Math.min(220, Math.max(45, rtt / 2 + 45)) : 30; // wait for a possibly faster answer still in flight
        A.t.grace = T.after(g, finish);
      }
    } else if (oa) finish(); else bump();
  }

  function finish() {
    if (!S || S.phase !== 'round') return;
    clearTimers();
    const r = S.round, answer = A.answer, mode = r.mode;
    const oks = Object.entries(A.attempts).filter(([, a]) => a.ok).sort((a, b) => a[1].ms - b[1].ms || a[1].at - b[1].at);
    const winner = oks.length ? oks[0][0] : null;
    const margin = oks.length > 1 ? oks[1][1].ms - oks[0][1].ms : null;
    const res = { n: r.n, answer, mode, shown: mode === 'fix' ? r.shown : null, winner, margin, per: {} };
    let anyKeys = false;
    for (const name of S.order) {
      const p = S.players[name], a = A.attempts[name], lv = A.live[name];
      if (!p.connected) continue;
      p.rounds++;
      let prec = null, ops = null, notes = [];
      if (mode === 'copy') {
        const k = a ? a.keys : lv ? lv.k : 0, e = a ? a.errs : lv ? lv.e : 0, l = a ? a.el : lv ? lv.l : '';
        if (k > 0) { prec = Math.max(0, (k - e) / k); anyKeys = true; }
        for (const ch of l) p.letters[ch] = (p.letters[ch] || 0) + 1;
      } else if (a) {
        prec = E.similarity(a.text, answer); anyKeys = true;
        if (!a.ok) { ops = E.align(a.text, answer); notes = E.describe(ops); for (const ch of E.troubleLetters(ops)) p.letters[ch] = (p.letters[ch] || 0) + 1; }
      }
      if (prec != null) { p.precSum += prec; p.precN++; }
      if (a && a.ok) { p.correct++; p.msSum += a.ms; p.chars += answer.length; if (p.bestMs == null || a.ms < p.bestMs) p.bestMs = a.ms; }
      if (name === winner) { p.wins++; p.streak++; p.bestStreak = Math.max(p.bestStreak, p.streak); } else p.streak = 0;
      res.per[name] = { ok: !!(a && a.ok), ms: a ? a.ms : null, text: a ? a.text : null, prec, ops, notes };
    }
    A.idle = anyKeys ? 0 : A.idle + 1;
    S.history.push(winner || '-'); if (S.history.length > 14) S.history.shift();
    S.result = res; S.phase = 'result';
    const wait = winner ? RESULT_MS : NOWIN_MS;
    res.wait = wait;
    A.t.next = T.after(wait, afterResult);
    bump();
  }

  function afterResult() {
    if (!S || S.phase !== 'result') return;
    if (connCount() < 2) { maybeLobby(); bump(); return; }
    if (A.idle >= 3) { A.idle = 0; S.phase = 'paused'; S.pausedWhy = 'idle'; bump(); return; }
    if (S.pauseNext) { S.pauseNext = false; S.phase = 'paused'; S.pausedWhy = 'pause'; bump(); return; }
    startRound();
  }

  function bump() {
    S.v++;
    if (net && net.hasGuest()) net.send({ t: 'state', s: S });
    applyState();
  }

  /* ---------- client: applying state ---------- */
  function applyState() {
    if (!S) return;
    if (S.phase === 'round' && S.round && (!R || R.n !== S.round.n)) setupRound(S.round);
    if (S.phase === 'round' && S.round && R && S.round.locked.includes(me) && !R.done) { R.done = true; R.locked = true; }
    if (S.phase === 'result' && S.result && lastResultN !== S.result.n) { lastResultN = S.result.n; onResult(); }
    render();
  }

  function setupRound(r) {
    const startLocal = net.toLocal(r.startAt);
    R = { n: r.n, mode: r.mode, shown: r.shown, len: r.len, say: r.say, startLocal, limit: r.limit, typed: '', keys: 0, errs: 0, errLetters: '', done: false, locked: false, started: false, lastN: -1, ms: null };
    oppProg = 0;
    const t = $('typer'); t.value = ''; t.readOnly = true; t.className = 'typer';
    $('liveNote').textContent = ''; $('liveNote').className = 'note';
    paintOppProg();
  }

  function onResult() {
    const res = S.result;
    try { speechSynthesis.cancel(); } catch (_) {}
    if (res.winner === me) Snd.win(); else if (res.winner) Snd.lose();
    $('typer').readOnly = true;
  }

  /* ---------- client: input ---------- */
  const typer = $('typer');
  const normTs = (ts) => (ts > 1e11 ? performance.now() : ts);
  const liveOK = () => R && S && S.phase === 'round' && !R.done && R.started && performance.now() >= R.startLocal;
  typer.addEventListener('beforeinput', (e) => { if (/paste|drop|yank/i.test(e.inputType || '')) e.preventDefault(); });
  typer.addEventListener('paste', (e) => e.preventDefault());
  typer.addEventListener('input', (e) => {
    if (!liveOK()) { typer.value = R && R.done ? R.typed : ''; return; }
    let v = typer.value.toLowerCase();
    const clean = v.replace(/[^a-z]/g, '');
    if (clean !== v) { typer.value = clean; v = clean; }
    const prev = R.typed; R.typed = v;
    const ts = normTs(e.timeStamp);
    if (R.mode === 'copy') {
      if (v.length > prev.length) {
        const add = v.length - prev.length; R.keys += add;
        if (!R.shown.startsWith(v)) {
          R.errs += add;
          if (R.shown.startsWith(prev)) R.errLetters += R.shown[prev.length] || '';
          Snd.wrong(); typer.classList.remove('shake'); void typer.offsetWidth; typer.classList.add('shake');
        }
      }
      typer.classList.toggle('wrong', !R.shown.startsWith(v));
      paintCopy();
      if (v === R.shown) { submit(ts); return; }
    }
    sendProg();
  });
  typer.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (R && R.mode !== 'copy' && liveOK() && R.typed.length > 0) submit(normTs(e.timeStamp));
    }
  });

  function sendProg() {
    if (!R) return;
    const p = R.mode === 'copy' ? (R.shown.startsWith(R.typed) ? R.typed.length / R.len : commonPrefix(R.typed, R.shown) / R.len) : Math.min(1, R.typed.length / R.len);
    const m = { t: 'prog', n: R.n, p, k: R.keys, e: R.errs, l: R.errLetters };
    if (role === 'host') recordLive(me, m);
    if (net) net.send(m);
  }
  function commonPrefix(a, b) { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; }

  function submit(ts) {
    R.done = true; R.ms = Math.max(0, ts - R.startLocal);
    typer.readOnly = true;
    if (R.mode === 'copy') { typer.classList.remove('wrong'); typer.classList.add('good'); $('liveNote').textContent = 'Done in ' + fmt(R.ms); $('liveNote').className = 'note green'; Snd.done(); }
    else { $('liveNote').textContent = 'Locked in. Waiting for the result'; $('liveNote').className = 'note'; Snd.done(); }
    const m = { t: 'sub', n: R.n, text: R.typed, ms: R.ms, keys: R.keys, errs: R.errs, el: R.errLetters };
    sendProgFinal();
    act(m);
  }
  function sendProgFinal() { if (net) net.send({ t: 'prog', n: R.n, p: 1, k: R.keys, e: R.errs, l: R.errLetters }); }

  /* ---------- rendering ---------- */
  const prompt = $('prompt');
  function paintCopy() {
    const s = R.shown, t = R.typed;
    const mm = commonPrefix(t, s);
    let html = '';
    for (let i = 0; i < s.length; i++) {
      const cls = i < mm ? 'ok' : i < t.length ? 'bad' : '';
      html += '<span class="ch ' + cls + '">' + s[i] + '</span>';
    }
    prompt.innerHTML = html;
  }
  function paintOppProg() {
    const g = $('card1'), prog = g.querySelector('.prog');
    if (prog) prog.style.width = Math.round(Math.min(1, oppProg) * 100) + '%';
  }

  function enterLive() {
    R.started = true;
    pane('st-live');
    typer.readOnly = R.done; typer.value = ''; typer.className = 'typer';
    const prm = $('prompt'), hint = $('promptHint'), hear = $('hearBtn');
    prm.className = 'prompt'; hear.classList.toggle('hidden', R.mode !== 'hear');
    if (R.mode === 'copy') { paintCopy(); hint.textContent = 'Type the word.'; }
    else if (R.mode === 'fix') { prm.classList.add('fix'); prm.textContent = R.shown; hint.textContent = 'This is misspelled. Type it correctly and press Enter. One try.'; }
    else { prm.classList.add('hear'); prm.textContent = Array(R.len).fill('_').join(' '); hint.textContent = R.len + ' letters. Spell it and press Enter. One try.'; speak(R.say); }
    $('liveNote').textContent = ''; $('liveNote').className = 'note';
    if (R.locked) lockedNote();
    Snd.go();
    if (!R.locked) typer.focus({ preventScroll: true });
  }
  function lockedNote() { typer.readOnly = true; $('liveNote').textContent = 'Not quite. You are out this round.'; $('liveNote').className = 'note red'; }
  $('hearBtn').onclick = () => { if (R && R.say) speak(R.say); typer.focus({ preventScroll: true }); };
  function speak(w) {
    try { if (!('speechSynthesis' in window) || !w) return; speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(w); u.rate = 0.82; u.lang = 'en-US'; speechSynthesis.speak(u); } catch (_) {}
  }

  function frame() {
    requestAnimationFrame(frame);
    if (!inRoom || !S || !R || S.phase !== 'round') return;
    const t = performance.now(), toStart = R.startLocal - t;
    if (toStart > 0) {
      pane('st-count');
      const n = Math.min(3, Math.ceil(toStart / 1000));
      if (n !== R.lastN) {
        R.lastN = n; const c = $('countNum'); c.textContent = n; c.className = 'countnum'; void c.offsetWidth; c.classList.add('pop');
        $('countHint').textContent = { copy: 'Copy the word', fix: 'Fix the spelling', hear: 'Listen closely' }[R.mode]; Snd.tick();
      }
      return;
    }
    if (!R.started) enterLive();
    const el = t - R.startLocal;
    if (!R.done) $('clock').textContent = (el / 1000).toFixed(1) + ' s'; else if (R.ms != null) $('clock').textContent = (R.ms / 1000).toFixed(2) + ' s';
    const left = Math.max(0, 1 - el / R.limit), tf = $('timerFill');
    tf.style.transform = 'scaleX(' + left.toFixed(4) + ')';
    tf.className = 'timerfill' + (left < 0.2 ? ' danger' : left < 0.5 ? ' warn' : '');
  }
  requestAnimationFrame(frame);

  function cardInto(node, name, isMe) {
    node.className = 'card'; node.textContent = '';
    const p = name && S ? S.players[name] : null;
    if (!p) {
      node.classList.add('empty');
      node.append(el('div', 'card-top', null)); node.firstChild.append(el('div', 'pname', 'Waiting'));
      node.append(el('div', 'wins', '0'));
      return;
    }
    const top = el('div', 'card-top');
    const nm = el('div', 'pname', p.name); if (isMe) nm.append(el('span', 'you', ' (you)'));
    top.append(nm);
    const locked = S.phase === 'round' && S.round && S.round.locked.includes(name);
    if (!p.connected) top.append(el('span', 'tag', 'Away'));
    else if (locked) top.append(el('span', 'tag out', 'Out'));
    else if (S.phase === 'ready' && p.ready) top.append(el('span', 'tag ready', 'Ready'));
    node.append(top, el('div', 'wins', String(p.wins)));
    const st = el('div', 'stats');
    const acc = p.precN ? Math.round((p.precSum / p.precN) * 100) + '%' : 'none';
    const avg = p.correct ? fmt(p.msSum / p.correct) : 'none';
    const mk = (k, v) => { const s = el('span', null, k + ' '); s.append(el('b', null, v)); return s; };
    st.append(mk('Accuracy', acc), mk('Avg', avg), mk('Best', p.bestMs != null ? fmt(p.bestMs) : 'none'));
    node.append(st);
    if (p.streak >= 2) node.append(el('span', 'streak', p.streak + ' in a row'));
    const top2 = Object.entries(p.letters).filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([l]) => l);
    if (top2.length) node.append(el('div', 'trips', 'Trips on ' + top2.join(', ')));
    if (S.phase === 'result' && S.result) {
      if (S.result.winner === name) node.classList.add('win'); else if (S.result.winner) node.classList.add('lose');
    }
    if (!isMe) node.append(el('div', 'prog'));
  }

  function renderNet() {
    const dot = $('net').querySelector('.dot'), txt = $('netTxt');
    const rtt = role === 'host' ? (net && net.hasGuest() ? net.peerRtt : null) : (net ? net.rtt : null);
    dot.className = 'dot';
    if (!role) { txt.textContent = 'connecting'; return; }
    if (rtt == null) { txt.textContent = role === 'host' && !(net && net.hasGuest()) ? 'online' : 'syncing'; if (role === 'host') dot.classList.add('good'); return; }
    const ms = Math.round(rtt);
    txt.textContent = ms + ' ms';
    dot.classList.add(ms < 60 ? 'good' : ms < 120 ? 'ok' : ms < 220 ? 'slow' : 'bad');
  }

  const MODE_NOTE = {
    copy: 'Copy: type the word as fast as you can. Every wrong key costs time.',
    fix: 'Fix: the word is misspelled. Type it correctly. One try per round.',
    hear: 'Hear: listen, then spell it from sound alone. One try per round.'
  };

  function render() {
    renderNet();
    $('soundBtn').textContent = Snd.on ? 'Sound on' : 'Sound off';
    $('soundBtn').setAttribute('aria-pressed', String(Snd.on));
    if (!S) { cardInto($('card0'), null, true); cardInto($('card1'), null, false); pane('st-wait'); $('waitTitle').textContent = 'Connecting'; $('waitSub').textContent = 'Finding the room.'; return; }
    const opp = guestName();
    cardInto($('card0'), me, true); cardInto($('card1'), opp, false);
    paintOppProg();

    // stage
    const ph = S.phase;
    if (ph === 'wait') { pane('st-wait'); $('waitTitle').textContent = 'Waiting for your friend'; $('waitSub').textContent = 'They open the site, tap Join private room, and enter code ' + ROOM + '.'; }
    else if (ph === 'ready') {
      pane('st-ready');
      const mine = S.players[me];
      $('readyBtn').textContent = mine && mine.ready ? 'Waiting for ' + (opp || 'opponent') : 'Ready';
      $('readyBtn').classList.toggle('primary', !(mine && mine.ready));
    } else if (ph === 'round' && R) {
      if (performance.now() < R.startLocal) pane('st-count'); else if (R.started) pane('st-live');
    } else if (ph === 'result' && S.result) { renderResult(); pane('st-result'); }
    else if (ph === 'paused') {
      pane('st-paused');
      $('pausedTitle').textContent = S.pausedWhy === 'idle' ? 'Paused, nobody was typing' : 'Paused';
      $('pausedSub').textContent = S.pausedWhy === 'idle' ? 'Press Resume when you are both back.' : 'Take a breath. Resume whenever you are ready.';
    }

    // controls
    document.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-pressed', String(S.settings[b.dataset.k] === b.dataset.v)));
    $('modeNote').textContent = MODE_NOTE[S.settings.mode] + (S.settings.level === 'ramp' ? ' Words get harder as you go.' : '');
    const pb = $('pauseBtn');
    pb.classList.toggle('hidden', ph === 'paused');
    pb.disabled = !(ph === 'round' || ph === 'result');
    pb.textContent = S.pauseNext ? 'Pausing after this round' : 'Pause';
    const h = $('history'); h.textContent = '';
    for (const w of S.history) { const i = document.createElement('i'); i.className = w === '-' ? 'n' : w === me ? 'w' : 'l'; i.title = w === '-' ? 'No winner' : w + ' won'; h.append(i); }
  }

  let renderedResult = 0;
  function renderResult() {
    const res = S.result;
    if (renderedResult === res.n) return;
    renderedResult = res.n;
    const t = $('resTitle');
    t.className = 'restitle';
    if (res.winner === me) { t.textContent = 'You won the round'; t.classList.add('win'); }
    else if (res.winner) { t.textContent = res.winner + ' won the round'; t.classList.add('lose'); }
    else t.textContent = 'No winner';
    $('resWord').textContent = res.answer;
    let sub = '';
    if (res.mode === 'fix' && res.shown) sub = 'It was shown as ' + res.shown + '.';
    if (res.winner && res.margin != null) sub = (res.winner === me ? 'You were' : res.winner + ' was') + ' ' + (res.margin / 1000).toFixed(3) + ' s faster. ' + sub;
    $('resSub').textContent = sub.trim();
    const rows = $('resRows'); rows.textContent = '';
    const order = [me, ...S.order.filter((k) => k !== me)];
    for (const name of order) {
      const per = res.per[name]; if (!per && !S.players[name]) continue;
      const row = el('div', 'row' + (res.winner === name ? ' win' : ''));
      row.append(el('div', 'rn', name + (name === me ? ' (you)' : '')));
      const big = el('div', 'rt');
      if (per && per.ok) big.textContent = fmt(per.ms); else if (per && per.text != null) { big.textContent = 'Wrong'; big.classList.add('bad'); } else { big.textContent = 'No answer'; big.classList.add('none'); }
      row.append(big);
      if (per && per.ops && per.ops.length) {
        const ty = el('div', 'typed');
        for (const o of per.ops) {
          if (o.k === 'ok') ty.append(el('span', 'ok', o.t));
          else if (o.k === 'sub' || o.k === 'swap') ty.append(el('span', 'bad', o.t));
          else if (o.k === 'extra') ty.append(el('span', 'extra', o.t));
          else ty.append(el('span', 'miss', o.a));
        }
        row.append(ty);
        if (per.notes && per.notes.length) row.append(el('div', 'rm', per.notes.join(', ')));
      }
      if (per && per.prec != null) row.append(el('div', 'rm', Math.round(per.prec * 100) + '% accurate'));
      rows.append(row);
    }
    const nf = $('nextFill'); nf.style.transition = 'none'; nf.style.width = '0'; void nf.offsetWidth;
    nf.style.transition = 'width ' + (res.wait || RESULT_MS) + 'ms linear'; nf.style.width = '100%';
  }

  /* ---------- buttons ---------- */
  $('readyBtn').onclick = () => { Snd.init(); const mine = S && S.players[me]; act({ t: 'ready', v: !(mine && mine.ready) }); };
  $('resumeBtn').onclick = () => { Snd.init(); act({ t: 'resume' }); };
  $('pauseBtn').onclick = () => act({ t: 'pause' });
  $('resetBtn').onclick = () => {
    const b = $('resetBtn');
    if (!resetArm) { resetArm = setTimeout(() => { resetArm = 0; b.textContent = 'Reset scores'; }, 3000); b.textContent = 'Tap again to reset'; return; }
    clearTimeout(resetArm); resetArm = 0; b.textContent = 'Reset scores'; act({ t: 'reset' });
  };
  document.querySelectorAll('.seg button').forEach((b) => (b.onclick = () => act({ t: 'set', k: b.dataset.k, v: b.dataset.v })));
  $('soundBtn').onclick = () => { Snd.on = !Snd.on; store.set('sr-sound', Snd.on ? 'on' : 'off'); Snd.init(); render(); };
  document.addEventListener('visibilitychange', () => { if (!document.hidden && R && liveOK()) typer.focus({ preventScroll: true }); });
  document.getElementById('stage').addEventListener('pointerdown', () => { if (R && liveOK()) setTimeout(() => typer.focus({ preventScroll: true }), 0); });
})();
