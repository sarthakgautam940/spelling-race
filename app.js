(function () {
  'use strict';

  const ROOM = '91409';
  const qs = new URLSearchParams(location.search);
  const SPEED = qs.get('fast') ? 0.3 : 1;            // test switch: shorter pauses
  const MAX = 8;
  const TOTAL = Math.min(10, +qs.get('rounds') || 10); // rounds per game (always 10 unless testing)
  const COUNT_MS = 3000 * SPEED, RESULT_MS = 4800 * SPEED, NOWIN_MS = 3200 * SPEED;
  const WINDOW_MS = 4000 * SPEED;                            // others keep typing this long after the first correct answer
  const FINAL_MS = 16000 * SPEED, AWAY_GRACE = 25000;
  const E = window.Engine;
  const $ = (id) => document.getElementById(id);
  const BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt', 'wss://test.mosquitto.org:8081/mqtt'];
  const brokers = qs.get('broker') ? qs.get('broker').split(',') : BROKERS; // ?broker=ws://localhost:8883 for testing

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
  const ensureDeps = () => depsP || (depsP = (window.WORDS ? Promise.resolve() : loadScript('words.js')).catch((e) => { depsP = null; throw e; }));

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
  let inRoom = false, lastResultN = 0, lastFinalId = '', renderedFinal = '', banner = '', resetArm = 0, progs = {};
  const T = window.Timers;

  const newState = () => ({ v: 0, phase: 'wait', settings: { mode: 'copy', level: 'ramp' }, players: {}, order: [], waiting: [], round: null, result: null, final: null, history: [], crowns: {}, match: { no: 0, round: 0, total: TOTAL }, pauseNext: false, pausedWhy: null, roundN: 0 });
  const newPlayer = (name) => ({ name, points: 0, wins: 0, streak: 0, bestStreak: 0, connected: true, ready: false, rounds: 0, correct: 0, precSum: 0, precN: 0, msSum: 0, bestMs: null, chars: 0, letters: {} });

  /* ---------- views ---------- */
  const views = ['v-home', 'v-code', 'v-name', 'v-room'];
  function show(id) { views.forEach((v) => $(v).classList.toggle('hidden', v !== id)); inRoom = id === 'v-room'; window.scrollTo(0, 0); }
  const panes = ['st-wait', 'st-ready', 'st-count', 'st-live', 'st-result', 'st-final', 'st-paused'];
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
    me = name; role = null; S = null; R = null; lastState = null; lastResultN = 0; progs = {}; curPane = '';
    show('v-room'); setBanner('Connecting', false); render();
    try { await ensureDeps(); } catch (_) { setBanner('Could not load the game files. Check your connection and reload.', true); return; }
    net = window.Net({
      room: ROOM, name, brokers, max: MAX, debug: !!qs.get('debug'),
      on: {
        status(s) {
          if (s === 'online') setBanner('', false);
          else if (s === 'offline') setBanner('Cannot reach the game relay. Check your connection, still trying', true);
          else if (!role) setBanner('Connecting', false);
        },
        role(r) { role = r; if (r === 'host') initHost(); },
        welcome(m) { if (m.name) me = m.name; },
        hello: onHello,
        rejoined() { if (role === 'host' && S) bump(); },
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
    if (qs.get('debug')) window.__sr = { net, crash: () => net.crash() };
  }

  function leave() {
    if (A && A.syncStop) A.syncStop();
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
    if (A && A.syncStop) A.syncStop();
    if (A && A.graceT) T.clear(A.graceT);
    A = { answer: null, attempts: {}, live: {}, used: new Set(), t: {}, idle: 0, wordSet: null, grace: false, graceT: 0 };
    if (lastState) { // another host left: keep the game for a moment so everyone can come back with their points
      S = lastState; lastState = null;
      S.phase = 'wait'; S.round = null; S.result = null; S.final = null; S.waiting = []; S.pauseNext = false; S.pausedWhy = null;
      for (const k of S.order) { if (k !== me) { S.players[k].connected = false; S.players[k].ready = false; } }
      A.grace = true;
      A.graceT = T.after(AWAY_GRACE, () => {
        if (!S) return;
        A.grace = false;
        for (const k of S.order.slice()) if (!S.players[k].connected) { delete S.players[k]; S.order = S.order.filter((x) => x !== k); }
        maybeLobby(); bump();
      });
    } else S = newState();
    A.syncStop = T.every(4000, () => { if (role === 'host' && S && net) net.sendAll({ t: 'state', s: S }); }); // heals any dropped message
    addPlayer(me);
    maybeLobby(); setBanner('', false); bump();
  }
  function addPlayer(name) {
    if (!S.players[name]) S.players[name] = newPlayer(name);
    S.players[name].connected = true; S.players[name].ready = false;
    if (!S.order.includes(name)) S.order.push(name);
  }
  const active = () => S.order.filter((k) => S.players[k].connected);   // players in the current game
  const connCount = () => active().length;
  const matchOn = () => S.match.round > 0;                              // a game is underway: newcomers wait for the next one
  function clearTimers() { for (const k of Object.keys(A.t)) { T.clear(A.t[k]); delete A.t[k]; } }

  /* Everyone online, zero points. Players who left are gone, and anyone waiting joins now. */
  function freshGame() {
    clearTimers();
    for (const k of S.order.slice()) if (!S.players[k].connected) { delete S.players[k]; S.order = S.order.filter((x) => x !== k); }
    for (const k of S.order) S.players[k] = Object.assign(newPlayer(k), { connected: true });
    for (const n of S.waiting) addPlayer(n);
    S.waiting = [];
    S.history = []; S.match.round = 0; S.round = null; S.result = null; S.final = null; S.pauseNext = false; S.pausedWhy = null;
    A.idle = 0; progs = {}; R = null;
  }

  function maybeLobby() {
    const act = connCount();
    if (act < 2) {
      if (A.grace) { S.phase = 'wait'; return; } // old players may still be coming back after a host change
      if (S.phase !== 'wait' || matchOn() || S.waiting.length) { freshGame(); }
      S.phase = connCount() >= 2 ? 'ready' : 'wait';
      return;
    }
    if (S.phase === 'wait') {
      if (S.match.round > 0 && S.match.round < S.match.total) {
        S.phase = 'paused'; S.pausedWhy = 'host'; // a host change is not a pause: carry on by itself once people are back
        A.t.resume = T.after(3000, () => { if (S && S.phase === 'paused' && S.pausedWhy === 'host' && connCount() >= 2) startRound(); });
      }
      else { if (S.match.round) freshGame(); S.phase = 'ready'; S.order.forEach((k) => (S.players[k].ready = false)); }
    }
  }

  function onHello(m, accept) {
    if (!S) return accept(false, 'full');
    const name = String(m.name || '').replace(/\s+/g, ' ').trim().slice(0, 14);
    if (!name) return accept(false, 'name');
    const lower = name.toLowerCase();
    const key = S.order.find((k) => k.toLowerCase() === lower);
    if (key) {
      if (S.players[key].connected) return accept(false, 'name');
      S.players[key].connected = true; S.players[key].ready = false; // came back within the host handover
      accept(true, null, { name: key });
    } else if (S.waiting.some((k) => k.toLowerCase() === lower)) return accept(false, 'name');
    else if (connCount() + S.waiting.length >= MAX) return accept(false, 'full');
    else if (matchOn()) { S.waiting.push(name); accept(true, null, { name }); } // joins when this game ends, on zero points
    else { addPlayer(name); accept(true, null, { name }); }
    maybeLobby(); bump();
  }

  function onGuestLeft(name) {
    if (!S) return;
    S.waiting = S.waiting.filter((k) => k !== name);
    if (S.players[name]) { delete S.players[name]; S.order = S.order.filter((k) => k !== name); } // gone from the board, points and all
    delete progs[name];
    maybeLobby();
    if (S.phase === 'round') checkAllIn();
    else if (S.phase === 'ready' && connCount() >= 2 && active().every((k) => S.players[k].ready)) startGame();
    bump();
  }

  /* ---------- message routing ---------- */
  function onMsg(m, from) {
    if (role === 'host') {
      if (!from) return;
      if (m.t === 'prog') {
        recordLive(from, m);
        if (R && m.n === R.n) { progs[from] = m.p || 0; paintProgs(); }
        net.sendAll({ t: 'prog', who: from, n: m.n, p: m.p || 0 }, from);
        return;
      }
      hostHandle(from, m);
    } else {
      if (m.t === 'state') { S = m.s; applyState(); }
      else if (m.t === 'prog') { if (R && m.n === R.n && m.who) { progs[m.who] = m.p || 0; paintProgs(); } }
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
        if (connCount() >= 2 && active().every((k) => S.players[k].ready)) startGame(); else bump();
        break;
      case 'set':
        if (m.k === 'mode' && ['copy', 'fix', 'hear'].includes(m.v)) S.settings.mode = m.v;
        else if (m.k === 'level' && ['ramp', 'easy', 'medium', 'hard'].includes(m.v)) S.settings.level = m.v;
        else return;
        bump(); break;
      case 'pause':
        if ((S.phase === 'round' || S.phase === 'result') && S.match.round < S.match.total) { S.pauseNext = !S.pauseNext; bump(); }
        break;
      case 'resume':
        if (S.phase === 'paused') startRound();
        break;
      case 'next':
        if (S.phase === 'final') startGame();
        break;
      case 'reset':
        freshGame(); S.phase = connCount() >= 2 ? 'ready' : 'wait'; bump(); break;
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

  function startGame() {
    if (!S || (S.phase !== 'ready' && S.phase !== 'final')) return;
    freshGame();
    S.match.no++;
    if (connCount() < 2) { S.phase = 'wait'; bump(); return; }
    startRound();
  }

  function startRound() {
    clearTimers();
    S.roundN++; S.match.round++;
    const mode = S.settings.mode;
    const { word, shown } = pickRound(mode, S.settings.level, S.match.round);
    const len = word.length;
    const limit = Math.min(30000, 9000 + len * 1200 + (mode === 'copy' ? 0 : 3000));
    A.answer = word; A.attempts = {}; A.live = {};
    S.round = { n: S.roundN, no: S.match.round, mode, shown: mode === 'hear' ? null : shown, len, say: mode === 'hear' ? word : null, startAt: net.hostNow() + COUNT_MS, limit, locked: [], done: [], first: null, closeAt: null, in: active() };
    S.result = null; S.phase = 'round'; S.pausedWhy = null;
    S.order.forEach((k) => (S.players[k].ready = false));
    A.t.end = T.after(COUNT_MS + limit, finish);
    bump();
  }

  function recordLive(name, m) {
    if (!A || !name || !S || !S.round || m.n !== S.round.n) return;
    A.live[name] = { k: m.k | 0, e: m.e | 0, l: String(m.l || '').slice(0, 60), p: m.p || 0 };
  }

  const roundPlayers = () => S.round.in.filter((k) => S.players[k] && S.players[k].connected);
  function checkAllIn() {
    const inn = roundPlayers();
    if (!inn.length || inn.every((k) => A.attempts[k])) finish();
  }

  function onSub(name, m) {
    if (S.phase !== 'round' || !S.round || m.n !== S.round.n || A.attempts[name] || !S.round.in.includes(name)) return;
    const text = String(m.text || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 40);
    const ms = Math.max(0, Number(m.ms) || 0);
    const ok = text === A.answer;
    A.attempts[name] = { text, ms, ok, keys: m.keys | 0, errs: m.errs | 0, el: String(m.el || '').slice(0, 60), at: performance.now() };
    if (ok) S.round.done.push(name); else S.round.locked.push(name);
    if (roundPlayers().every((k) => A.attempts[k])) { finish(); return; }
    if (ok && !S.round.first) {
      // the clock keeps running for everyone else, so placings are decided on measured time, not arrival order
      S.round.first = { name, ms };
      const left = Math.max(300, Math.min(WINDOW_MS, S.round.startAt + S.round.limit - net.hostNow()));
      S.round.closeAt = net.hostNow() + left;
      A.t.close = T.after(left, finish);
    }
    bump();
  }

  function finish() {
    if (!S || S.phase !== 'round') return;
    clearTimers();
    const r = S.round, answer = A.answer, mode = r.mode;
    const inn = roundPlayers();
    const oks = inn.filter((k) => A.attempts[k] && A.attempts[k].ok).sort((a, b) => A.attempts[a].ms - A.attempts[b].ms || A.attempts[a].at - A.attempts[b].at);
    const winner = oks.length ? oks[0] : null;
    const margin = oks.length > 1 ? A.attempts[oks[1]].ms - A.attempts[oks[0]].ms : null;
    const res = { n: r.n, no: r.no, answer, mode, shown: mode === 'fix' ? r.shown : null, winner, margin, per: {}, rank: [] };
    let anyKeys = false;
    for (const name of inn) {
      const p = S.players[name], a = A.attempts[name], lv = A.live[name];
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
      const place = oks.indexOf(name);
      const pts = E.roundPoints(place < 0 ? 0 : place, place >= 0, prec);
      p.points += pts.total;
      if (a && a.ok) { p.correct++; p.msSum += a.ms; p.chars += answer.length; if (p.bestMs == null || a.ms < p.bestMs) p.bestMs = a.ms; }
      if (name === winner) { p.wins++; p.streak++; p.bestStreak = Math.max(p.bestStreak, p.streak); } else p.streak = 0;
      res.per[name] = { ok: !!(a && a.ok), ms: a ? a.ms : null, text: a ? a.text : null, prec, ops, notes, pts, place: place < 0 ? null : place + 1 };
    }
    const tier = (k) => (res.per[k].ok ? 0 : res.per[k].text != null ? 1 : 2);
    res.rank = inn.slice().sort((a, b) => tier(a) - tier(b) || (res.per[a].ms || 0) - (res.per[b].ms || 0));
    A.idle = anyKeys ? 0 : A.idle + 1;
    S.history.push(winner || '-');
    S.result = res; S.phase = 'result';
    const wait = winner ? RESULT_MS : NOWIN_MS;
    res.wait = wait;
    A.t.next = T.after(wait, afterResult);
    bump();
  }

  function afterResult() {
    if (!S || S.phase !== 'result') return;
    if (connCount() < 2) { maybeLobby(); bump(); return; }
    if (S.match.round >= S.match.total) { finishGame(); return; }
    if (A.idle >= 3) { A.idle = 0; S.phase = 'paused'; S.pausedWhy = 'idle'; bump(); return; }
    if (S.pauseNext) { S.pauseNext = false; S.phase = 'paused'; S.pausedWhy = 'pause'; bump(); return; }
    startRound();
  }

  function finishGame() {
    const list = E.rank(active().map((k) => S.players[k]));
    const tied = list.filter((p) => E.compare(list[0], p) === 0).map((p) => p.name);
    for (const n of tied) S.crowns[n] = (S.crowns[n] || 0) + 1;
    S.final = {
      id: Math.random().toString(36).slice(2), no: S.match.no, winners: tied, wait: FINAL_MS,
      rank: list.map((p) => ({ name: p.name, points: p.points, wins: p.wins, correct: p.correct, acc: p.precN ? p.precSum / p.precN : null, avg: p.correct ? p.msSum / p.correct : null, best: p.bestMs }))
    };
    S.phase = 'final'; S.pauseNext = false;
    A.t.next = T.after(FINAL_MS, startGame);
    bump();
  }

  function bump() {
    S.v++;
    if (net && role === 'host') net.sendAll({ t: 'state', s: S });
    applyState();
  }

  /* ---------- client: applying state ---------- */
  function applyState() {
    if (!S) return;
    if (S.phase === 'round' && S.round && (!R || R.n !== S.round.n)) setupRound(S.round);
    if (S.phase === 'round' && S.round && R && S.round.locked.includes(me) && !R.done) { R.done = true; R.locked = true; }
    if (S.phase === 'result' && S.result && lastResultN !== S.result.n) { lastResultN = S.result.n; onResult(); }
    if (S.phase === 'final' && S.final && lastFinalId !== S.final.id) { lastFinalId = S.final.id; onFinal(); }
    render();
  }

  function setupRound(r) {
    const startLocal = net.toLocal(r.startAt);
    const spec = !r.in.includes(me);
    R = { n: r.n, mode: r.mode, shown: r.shown, len: r.len, say: r.say, startHost: r.startAt, startLocal, limit: r.limit, typed: '', keys: 0, errs: 0, errLetters: '', done: spec, spectator: spec, locked: false, started: false, lastN: -1, ms: null };
    progs = {};
    const t = $('typer'); t.value = ''; t.readOnly = true; t.className = 'typer';
    $('liveNote').textContent = ''; $('liveNote').className = 'note';
    paintProgs();
  }

  function onFinal() {
    try { speechSynthesis.cancel(); } catch (_) {}
    if (S.final.winners.includes(me)) Snd.win(); else Snd.done();
    $('typer').readOnly = true;
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

  let lastProg = 0, progT = 0;
  function sendProg(final) {
    if (!R || R.spectator) return;
    progs[me] = progressNow(final); paintProgs();
    const out = () => {
      progT = 0; if (!R) return;
      lastProg = performance.now();
      const m = { t: 'prog', n: R.n, p: progressNow(final), k: R.keys, e: R.errs, l: R.errLetters };
      if (role === 'host') { recordLive(me, m); if (net) net.sendAll({ t: 'prog', who: me, n: R.n, p: m.p }); }
      else if (net) net.send(m);
    };
    if (final) { clearTimeout(progT); out(); return; }
    const dt = performance.now() - lastProg;
    if (dt >= 90) out(); else if (!progT) progT = setTimeout(out, 90 - dt); // keep message rates low on a shared relay
  }
  function progressNow(final) {
    if (final) return 1;
    return R.mode === 'copy' ? commonPrefix(R.typed, R.shown) / R.len : Math.min(1, R.typed.length / R.len);
  }
  function commonPrefix(a, b) { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; }

  function submit(ts) {
    R.done = true; R.ms = Math.max(0, ts - R.startLocal);
    typer.readOnly = true;
    if (R.mode === 'copy') { typer.classList.remove('wrong'); typer.classList.add('good'); $('liveNote').textContent = 'Done in ' + fmt(R.ms); $('liveNote').className = 'note green'; Snd.done(); }
    else { $('liveNote').textContent = 'Locked in. Waiting for the result'; $('liveNote').className = 'note'; Snd.done(); }
    const m = { t: 'sub', n: R.n, text: R.typed, ms: R.ms, keys: R.keys, errs: R.errs, el: R.errLetters };
    sendProg(true);
    act(m);
  }

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
  function paintProgs() {
    document.querySelectorAll('#board .prow').forEach((row) => {
      const bar = row.querySelector('.prog');
      if (bar) bar.style.width = Math.round(Math.min(1, progs[row.dataset.name] || 0) * 100) + '%';
    });
  }

  function enterLive() {
    R.started = true;
    pane('st-live');
    typer.readOnly = R.done; typer.value = ''; typer.className = 'typer';
    const prm = $('prompt'), hint = $('promptHint'), hear = $('hearBtn');
    prm.className = 'prompt'; hear.classList.toggle('hidden', R.mode !== 'hear');
    if (R.mode === 'copy') { paintCopy(); hint.textContent = 'Type the word.'; }
    else if (R.mode === 'fix') { prm.classList.add('fix'); prm.textContent = R.shown; hint.textContent = 'This is misspelled. Type it correctly and press Enter. One try.'; }
    else { prm.classList.add('hear'); prm.textContent = Array(R.len).fill('_').join(' '); hint.textContent = R.len + ' letters. Spell it and press Enter. One try.'; if (!R.spectator) speak(R.say); }
    $('liveNote').textContent = ''; $('liveNote').className = 'note';
    if (R.locked) lockedNote();
    if (R.spectator) { typer.readOnly = true; $('liveNote').textContent = 'A game is underway. You play in the next one.'; }
    Snd.go();
    if (!R.locked && !R.spectator) typer.focus({ preventScroll: true });
  }
  function lockedNote() { typer.readOnly = true; $('liveNote').textContent = 'Not quite. You are out this round.'; $('liveNote').className = 'note red'; }
  $('hearBtn').onclick = () => { if (R && R.say) speak(R.say); typer.focus({ preventScroll: true }); };
  function speak(w) {
    try { if (!('speechSynthesis' in window) || !w) return; speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(w); u.rate = 0.82; u.lang = 'en-US'; speechSynthesis.speak(u); } catch (_) {}
  }

  function frame() {
    requestAnimationFrame(frame);
    if (!inRoom || !S || !R || S.phase !== 'round') return;
    if (!R.started && net) R.startLocal = net.toLocal(R.startHost); // re-derive until the clock sync settles, then it freezes at start
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
    let left = Math.max(0, 1 - el / R.limit);
    const fin = S.round && S.round.first;
    if (fin && S.round.closeAt) {
      const rem = net.toLocal(S.round.closeAt) - t;
      left = Math.max(0, Math.min(1, rem / WINDOW_MS));
      if (!R.done && !R.locked) {
        const secs = Math.max(0, Math.ceil(rem / 1000)), key = fin.name + secs;
        if (R.noteKey !== key) { R.noteKey = key; $('liveNote').textContent = (fin.name === me ? 'You' : fin.name) + ' finished first. ' + secs + ' s left'; $('liveNote').className = 'note orange'; }
      }
    }
    const tf = $('timerFill');
    tf.style.transform = 'scaleX(' + left.toFixed(4) + ')';
    tf.className = 'timerfill' + (left < 0.2 ? ' danger' : left < 0.5 ? ' warn' : '');
  }
  requestAnimationFrame(frame);

  function renderBoard() {
    const board = $('board'); board.textContent = '';
    if (!S) return;
    const list = E.rank(S.order.filter((k) => S.players[k].connected).map((k) => S.players[k])); // only people who are here
    list.forEach((p, i) => {
      const name = p.name, isMe = name === me;
      const row = el('div', 'prow'); row.dataset.name = name;
      if (isMe) row.classList.add('me');
      row.append(el('div', 'rank r' + (i + 1), String(i + 1)));
      const main = el('div', 'pmain');
      const top = el('div', 'card-top');
      const nm = el('div', 'pname', p.name); if (isMe) nm.append(el('span', 'you', ' (you)'));
      top.append(nm);
      const inRound = S.phase === 'round' && S.round && S.round.in.includes(name);
      if (inRound && S.round.locked.includes(name)) top.append(el('span', 'tag out', 'Out'));
      else if (inRound && S.round.done.includes(name)) top.append(el('span', 'tag done', 'Done'));
      else if (S.phase === 'ready' && p.ready) top.append(el('span', 'tag ready', 'Ready'));
      if (p.streak >= 2) top.append(el('span', 'streak', p.streak + ' in a row'));
      if (S.crowns[name]) top.append(el('span', 'crown', S.crowns[name] + (S.crowns[name] === 1 ? ' game won' : ' games won')));
      main.append(top);
      const st = el('div', 'stats');
      const mk = (k, v) => { const sp = el('span', null, k + ' '); sp.append(el('b', null, v)); return sp; };
      st.append(mk('Wins', String(p.wins)), mk('Accuracy', p.precN ? Math.round((p.precSum / p.precN) * 100) + '%' : 'none'), mk('Avg', p.correct ? fmt(p.msSum / p.correct) : 'none'));
      main.append(st);
      const trips = Object.entries(p.letters).filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([l]) => l);
      if (trips.length) main.append(el('div', 'trips', 'Trips on ' + trips.join(', ')));
      const pts = el('div', 'wins'); pts.append(document.createTextNode(String(p.points)), el('span', 'ptsl', 'pts'));
      row.append(main, pts, el('div', 'prog'));
      if (S.phase === 'result' && S.result && S.result.winner === name) row.classList.add('win');
      if (S.phase === 'final' && S.final && S.final.winners.includes(name)) row.classList.add('win');
      board.append(row);
    });
    const wn = $('waitNote'), w = S.waiting, others = w.filter((n) => n !== me);
    if (w.length) {
      wn.textContent = w.includes(me)
        ? 'You join the next game.' + (others.length ? ' Also waiting: ' + others.join(', ') + '.' : '')
        : others.join(', ') + (others.length > 1 ? ' join' : ' joins') + ' the next game.';
      wn.classList.remove('hidden');
    } else wn.classList.add('hidden');
    paintProgs();
  }

  function renderNet() {
    const dot = $('net').querySelector('.dot'), txt = $('netTxt');
    const host = role === 'host';
    const rtt = host ? (net ? net.maxPeerRtt() : null) : (net ? net.rtt : null);
    dot.className = 'dot';
    if (!role) { txt.textContent = 'connecting'; return; }
    if (rtt == null) { txt.textContent = host ? 'online' : 'syncing'; if (host) dot.classList.add('good'); return; }
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
    if (!S) { $('board').textContent = ''; pane('st-wait'); $('waitTitle').textContent = 'Connecting'; $('waitSub').textContent = 'Finding the room.'; return; }
    if (S.phase !== 'round') progs = {};
    renderBoard();
    renderTracker();

    // stage
    const ph = S.phase;
    if (ph === 'wait') { pane('st-wait'); $('waitTitle').textContent = 'Waiting for friends'; $('waitSub').textContent = 'Up to ' + MAX + ' can play. Everyone opens the site, taps Join private room, and enters code ' + ROOM + '.'; }
    else if (ph === 'ready') {
      pane('st-ready');
      const mine = S.players[me];
      const waiting = S.order.filter((k) => S.players[k].connected && !S.players[k].ready);
      $('readyBtn').textContent = mine && mine.ready ? 'Waiting for ' + waiting.join(', ') : 'Ready';
      $('readyBtn').classList.toggle('primary', !(mine && mine.ready));
    } else if (ph === 'round' && R) {
      if (performance.now() < R.startLocal) pane('st-count'); else if (R.started) pane('st-live');
    } else if (ph === 'result' && S.result) { renderResult(); pane('st-result'); }
    else if (ph === 'final' && S.final) { renderFinal(); pane('st-final'); }
    else if (ph === 'paused') {
      pane('st-paused');
      $('pausedTitle').textContent = S.pausedWhy === 'idle' ? 'Paused, nobody was typing' : S.pausedWhy === 'host' ? 'The host changed' : 'Paused';
      $('pausedSub').textContent = S.pausedWhy === 'idle' ? 'Press Resume when you are all back.' : S.pausedWhy === 'host' ? 'Your points are safe. Carrying on in a moment.' : 'Take a breath. Resume whenever you are ready.';
    }

    // controls
    document.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-pressed', String(S.settings[b.dataset.k] === b.dataset.v)));
    $('modeNote').textContent = MODE_NOTE[S.settings.mode] + (S.settings.level === 'ramp' ? ' Words get harder as you go.' : '');
    const pb = $('pauseBtn');
    pb.classList.toggle('hidden', ph === 'paused');
    pb.disabled = !((ph === 'round' || ph === 'result') && S.match.round < S.match.total);
    pb.textContent = S.pauseNext ? 'Pausing after this round' : 'Pause';
  }

  function renderTracker() {
    const m = S.match, ph = S.phase;
    $('roundInfo').textContent = m.round > 0 ? (m.round >= m.total && ph !== 'final' ? 'Last round' : ph === 'final' ? 'Game over' : 'Round ' + m.round + ' of ' + m.total) : m.total + ' rounds, most points wins';
    const d = $('dots'); d.textContent = '';
    for (let i = 0; i < m.total; i++) {
      const dot = document.createElement('i'), w = S.history[i];
      if (i < S.history.length) { dot.className = w === '-' ? 'n' : w === me ? 'w' : 'l'; dot.title = w === '-' ? 'Round ' + (i + 1) + ': no winner' : 'Round ' + (i + 1) + ': ' + w; }
      else if (ph === 'round' && i === m.round - 1) dot.className = 'cur';
      d.append(dot);
    }
  }

  const ordinal = (n) => { const v = n % 100, x = ['th', 'st', 'nd', 'rd']; return n + (x[(v - 20) % 10] || x[v] || x[0]); };
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
    if (res.winner && res.margin != null) sub = (res.winner === me ? 'You were' : res.winner + ' was') + ' ' + (res.margin / 1000).toFixed(3) + ' s ahead of second place. ' + sub;
    $('resSub').textContent = sub.trim();
    const rows = $('resRows'); rows.textContent = '';
    for (const name of res.rank) {
      const per = res.per[name];
      const row = el('div', 'row' + (res.winner === name ? ' win' : ''));
      row.append(el('div', 'rn', (per.place ? ordinal(per.place) + ' ' : '') + name + (name === me ? ' (you)' : '')));
      const big = el('div', 'rt');
      if (per.ok) big.textContent = fmt(per.ms); else if (per.text != null) { big.textContent = 'Wrong'; big.classList.add('bad'); } else { big.textContent = 'No answer'; big.classList.add('none'); }
      row.append(big);
      if (per.ops && per.ops.length) {
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
      if (per.prec != null) row.append(el('div', 'rm', Math.round(per.prec * 100) + '% accurate'));
      const pt = el('div', 'rpts', '+' + per.pts.total + ' pts'); if (!per.pts.total) pt.classList.add('zero');
      row.append(pt);
      if (per.pts.total) row.append(el('div', 'rm', per.pts.place + ' for place' + (per.pts.clean ? ', ' + per.pts.clean + ' for a clean run' : '')));
      rows.append(row);
    }
    const nf = $('nextFill'); nf.style.transition = 'none'; nf.style.width = '0'; void nf.offsetWidth;
    nf.style.transition = 'width ' + (res.wait || RESULT_MS) + 'ms linear'; nf.style.width = '100%';
  }

  function renderFinal() {
    const f = S.final;
    if (renderedFinal === f.id) return;
    renderedFinal = f.id;
    const t = $('finTitle'); t.className = 'restitle';
    const win = f.winners;
    const top = f.rank[0];
    if (win.length > 1) { t.textContent = 'A tie at the top'; $('finWord').textContent = win.join(' and '); }
    else if (win[0] === me) { t.textContent = 'You win the game'; t.classList.add('win'); $('finWord').textContent = top.points + ' points'; }
    else { t.textContent = win[0] + ' wins the game'; t.classList.add('lose'); $('finWord').textContent = top.points + ' points'; }
    $('finSub').textContent = 'Ranked by points, then round wins, accuracy and average time.';
    const rows = $('finRows'); rows.textContent = '';
    f.rank.forEach((r, i) => {
      const row = el('div', 'frow' + (win.includes(r.name) ? ' win' : ''));
      row.append(el('div', 'rank r' + (i + 1), String(i + 1)));
      const mid = el('div', 'pmain');
      mid.append(el('div', 'pname', r.name + (r.name === me ? ' (you)' : '')));
      mid.append(el('div', 'rm', r.wins + (r.wins === 1 ? ' round win' : ' round wins') + ', ' + (r.acc != null ? Math.round(r.acc * 100) + '% accurate' : 'no accuracy') + ', ' + (r.avg != null ? fmt(r.avg) + ' average' : 'no average')));
      const pts = el('div', 'wins'); pts.append(document.createTextNode(String(r.points)), el('span', 'ptsl', 'pts'));
      row.append(mid, pts);
      rows.append(row);
    });
    const nf = $('finFill'); nf.style.transition = 'none'; nf.style.width = '0'; void nf.offsetWidth;
    nf.style.transition = 'width ' + (f.wait || FINAL_MS) + 'ms linear'; nf.style.width = '100%';
  }

  /* ---------- buttons ---------- */
  $('nextBtn').onclick = () => { Snd.init(); act({ t: 'next' }); };
  $('readyBtn').onclick = () => { Snd.init(); const mine = S && S.players[me]; act({ t: 'ready', v: !(mine && mine.ready) }); };
  $('resumeBtn').onclick = () => { Snd.init(); act({ t: 'resume' }); };
  $('pauseBtn').onclick = () => act({ t: 'pause' });
  $('resetBtn').onclick = () => {
    const b = $('resetBtn');
    if (!resetArm) { resetArm = setTimeout(() => { resetArm = 0; b.textContent = 'Restart game'; }, 3000); b.textContent = 'Tap again to restart'; return; }
    clearTimeout(resetArm); resetArm = 0; b.textContent = 'Restart game'; act({ t: 'reset' });
  };
  document.querySelectorAll('.seg button').forEach((b) => (b.onclick = () => act({ t: 'set', k: b.dataset.k, v: b.dataset.v })));
  $('soundBtn').onclick = () => { Snd.on = !Snd.on; store.set('sr-sound', Snd.on ? 'on' : 'off'); Snd.init(); render(); };
  document.addEventListener('visibilitychange', () => { if (!document.hidden && R && liveOK()) typer.focus({ preventScroll: true }); });
  document.getElementById('stage').addEventListener('pointerdown', () => { if (R && liveOK()) setTimeout(() => typer.focus({ preventScroll: true }), 0); });
})();
