/* Peer to peer link. The first browser to claim the room id becomes the host and referee.
   Everyone else connects to it directly over WebRTC, so no server sits between players. */
(function () {
  'use strict';
  const now = () => performance.now();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* Timers that keep running on time even when the tab is in the background. */
  const Timers = (function () {
    let worker = null, seq = 0;
    const cbs = new Map();
    try {
      const src = 'const t=new Map();onmessage=e=>{const d=e.data;if(d.c){clearTimeout(t.get(d.c));t.delete(d.c);return}' +
        'if(d.i){const id=d.i;t.set(id,setTimeout(()=>{t.delete(id);postMessage(id)},d.ms))}};';
      worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      worker.onmessage = (e) => { const f = cbs.get(e.data); if (f) { cbs.delete(e.data); f(); } };
    } catch (_) { worker = null; }
    return {
      after(ms, fn) {
        const id = ++seq;
        if (!worker) { const h = setTimeout(fn, ms); cbs.set(id, null); cbs.set('h' + id, h); return id; }
        cbs.set(id, fn); worker.postMessage({ i: id, ms }); return id;
      },
      clear(id) {
        if (!id) return;
        if (!worker) { clearTimeout(cbs.get('h' + id)); cbs.delete('h' + id); cbs.delete(id); return; }
        if (cbs.delete(id)) worker.postMessage({ c: id });
      },
      every(ms, fn) {
        let id, stopped = false;
        const loop = () => { if (stopped) return; fn(); id = Timers.after(ms, loop); };
        id = Timers.after(ms, loop);
        return () => { stopped = true; Timers.clear(id); };
      }
    };
  })();

  const ghosts = new Map(); // slot -> when it last stayed silent

  function Net(cfg) {
    const self = { role: null, rtt: null, off: 0, synced: false };
    let peer = null, conn = null, stopped = false, stopPing = null, lastSeen = 0, epoch = 0;
    const samples = [];
    const guests = new Map(); // host side: connection -> { name, lastSeen, rtt }
    const emit = (k, ...a) => { if (cfg.on[k]) cfg.on[k](...a); };
    const dbg = (...a) => { if (cfg.debug) console.log('[net ' + Math.round(now()) + ']', ...a); };

    function mkPeer(id) {
      return new Promise((res, rej) => {
        const p = id ? new Peer(id, cfg.peerOpts) : new Peer(cfg.peerOpts);
        let done = false;
        const t = setTimeout(() => { if (!done) { done = true; try { p.destroy(); } catch (_) {} rej({ type: 'timeout' }); } }, 9000);
        p.on('open', () => { if (!done) { done = true; clearTimeout(t); res(p); } });
        p.on('error', (e) => { if (!done) { done = true; clearTimeout(t); try { p.destroy(); } catch (_) {} rej(e); } });
      });
    }

    function teardown() {
      if (stopPing) { stopPing(); stopPing = null; }
      try { if (conn) conn.close(); } catch (_) {}
      for (const c of guests.keys()) { try { c.close(); } catch (_) {} }
      guests.clear();
      try { if (peer) peer.destroy(); } catch (_) {}
      peer = conn = null; self.role = null; self.synced = false; self.rtt = null; samples.length = 0;
    }

    const SLOTS = cfg.slots || 6;
    const slotId = (i) => cfg.hostId + '-s' + i;
    const isGhost = (i) => ghosts.has(i) && now() - ghosts.get(i) < 90000;

    /* Try to join the host registered on slot i. Resolves joined, rejected, free (slot vanished) or ghost (silent). */
    function joinSlot(p, i, timeout) {
      return new Promise((resolve) => {
        let settled = false;
        const c = p.connect(slotId(i), { reliable: true, serialization: 'json' });
        const onErr = (e) => { if (e && e.type === 'peer-unavailable' && String(e.message || '').endsWith(slotId(i))) fin('free'); };
        const fin = (r) => { if (settled) return; settled = true; clearTimeout(to); p.off('error', onErr); resolve(r); };
        const to = setTimeout(() => { try { c.close(); } catch (_) {} fin('ghost'); }, timeout);
        p.on('error', onErr);
        c.on('open', () => { try { c.send({ t: 'hello', name: cfg.name }); } catch (_) {} });
        c.on('data', (m) => {
          if (settled || !m || typeof m !== 'object') return;
          if (m.t === 'welcome') {
            fin('joined');
            c.on('data', (d) => {
              if (!d || typeof d !== 'object') return;
              lastSeen = now();
              if (d.t === 'pong') { onPong(d); return; }
              emit('msg', d);
            });
            c.on('close', () => hostLost(c)); c.on('error', () => hostLost(c));
            peer = p; conn = c; self.role = 'guest'; self.slot = i; lastSeen = now();
            dbg('joined host on slot', i);
            startGuestPings();
            emit('welcome', m); emit('role', 'guest'); emit('status', 'online');
          } else if (m.t === 'reject') { try { c.close(); } catch (_) {} fin('rejected'); emit('rejected', m.why); }
        });
        const bad = () => fin('ghost');
        c.on('close', bad); c.on('error', bad);
      });
    }

    /* Slots are claimed in order. A taken slot is either a live host (it answers) or a ghost left behind by a
       connection that died without closing (it stays silent and is skipped for a while). */
    async function run() {
      const my = ++epoch;
      let attempt = 0, gp = null;
      const closeGp = () => { try { if (gp) gp.destroy(); } catch (_) {} gp = null; };
      const alive = () => !stopped && my === epoch;
      while (alive()) {
        emit('status', 'looking', attempt); dbg('looking, attempt', attempt);
        const timeout = 4000 + Math.min(attempt, 3) * 1500;
        let again = false;
        for (let i = 0; i < SLOTS && alive(); i++) {
          if (isGhost(i)) { dbg('skipping ghost slot', i); continue; }
          let tries = 0, resolved = false;
          while (!resolved && tries++ < 3 && alive()) {
            let p = null;
            try { p = await mkPeer(slotId(i)); }
            catch (e) {
              if (!e || e.type !== 'unavailable-id') { emit('status', 'offline'); again = true; resolved = true; break; }
              dbg('slot', i, 'taken, trying to join');
              if (!gp) { try { gp = await mkPeer(null); } catch (_) { emit('status', 'offline'); again = true; resolved = true; break; } }
              if (!alive()) { closeGp(); return; }
              const r = await joinSlot(gp, i, timeout);
              dbg('slot', i, 'result', r);
              if (r === 'joined') return;
              if (r === 'rejected') { stopped = true; closeGp(); return; }
              if (r === 'ghost') { ghosts.set(i, now()); resolved = true; }
              continue; // 'free': it vanished, claim it
            }
            closeGp();
            if (!alive()) { try { p.destroy(); } catch (_) {} return; }
            self.slot = i; dbg('host on slot', i); becomeHost(p); return;
          }
          if (again) break;
        }
        if (SLOTS && [...Array(SLOTS).keys()].every(isGhost)) ghosts.clear();
        await sleep(Math.min(3000, 400 + attempt * 400)); attempt++;
      }
      closeGp();
    }

    function dropGuest(c, announce) {
      const g = guests.get(c); if (!g) return;
      guests.delete(c);
      try { c.close(); } catch (_) {}
      if (announce && g.name) emit('guestLeft', g.name);
    }

    function becomeHost(p) {
      peer = p; self.role = 'host';
      p.on('disconnected', () => { if (!stopped && peer === p) { try { p.reconnect(); } catch (_) {} } });
      p.on('error', () => {});
      p.on('connection', (c) => {
        if (guests.size >= cfg.max - 1) {
          c.on('open', () => { try { c.send({ t: 'reject', why: 'full' }); } catch (_) {} setTimeout(() => { try { c.close(); } catch (_) {} }, 300); });
          return;
        }
        const g = { name: null, lastSeen: now(), rtt: null };
        guests.set(c, g);
        c.on('data', (m) => {
          if (!m || typeof m !== 'object' || !guests.has(c)) return;
          g.lastSeen = now();
          if (m.t === 'ping') { g.rtt = m.rtt; try { c.send({ t: 'pong', c: m.c, h: now() }); } catch (_) {} emit('rtt'); return; }
          if (m.t === 'hello') {
            // a reconnecting player whose old link went quiet should not be locked out by it
            for (const [oc, og] of guests) {
              if (oc !== c && og.name && String(m.name || '').toLowerCase() === og.name.toLowerCase() && now() - og.lastSeen > 3000) dropGuest(oc, true);
            }
            emit('hello', m, (ok, why, extra) => {
              try { c.send(ok ? Object.assign({ t: 'welcome' }, extra || {}) : { t: 'reject', why }); } catch (_) {}
              if (ok) g.name = extra && extra.name ? extra.name : m.name;
              else { guests.delete(c); setTimeout(() => { try { c.close(); } catch (_) {} }, 300); }
            });
            return;
          }
          if (g.name) emit('msg', m, g.name);
        });
        const gone = () => dropGuest(c, true);
        c.on('close', gone); c.on('error', gone);
      });
      stopPing = Timers.every(1000, () => {
        for (const [c, g] of guests) if (now() - g.lastSeen > 7000) dropGuest(c, true);
      });
      emit('role', 'host'); emit('status', 'online');
    }

    function hostLost(c) {
      if (stopped || conn !== c) return;
      emit('hostLost');
      teardown();
      run();
    }

    function startGuestPings() {
      let burst = 0;
      const ping = () => { if (conn) try { conn.send({ t: 'ping', c: now(), rtt: self.rtt }); } catch (_) {} };
      ping();
      const fast = setInterval(() => { ping(); if (++burst >= 10) clearInterval(fast); }, 110);
      stopPing = Timers.every(1000, () => {
        ping();
        if (conn && now() - lastSeen > 6000) hostLost(conn);
      });
      const prev = stopPing;
      stopPing = () => { clearInterval(fast); prev(); };
    }

    function onPong(m) {
      const t = now(), rtt = t - m.c;
      samples.push({ rtt, off: m.h + rtt / 2 - t });
      if (samples.length > 14) samples.shift();
      let best = samples[0];
      for (const s of samples) if (s.rtt < best.rtt) best = s;
      self.off = best.off; self.synced = true;
      self.rtt = self.rtt == null ? rtt : self.rtt * 0.6 + rtt * 0.4;
      emit('rtt', self.rtt);
    }

    self.send = (m) => { if (conn && conn.open) { try { conn.send(m); } catch (_) {} } }; // guest to host
    self.sendAll = (m, except) => { for (const [c, g] of guests) if (g.name && g.name !== except && c.open) { try { c.send(m); } catch (_) {} } };
    self.guestCount = () => { let n = 0; for (const g of guests.values()) if (g.name) n++; return n; };
    self.maxPeerRtt = () => { let r = null; for (const g of guests.values()) if (g.name && g.rtt != null && (r == null || g.rtt > r)) r = g.rtt; return r; };
    self.toLocal = (hostT) => (self.role === 'host' ? hostT : hostT - self.off);
    self.hostNow = () => (self.role === 'host' ? now() : now() + self.off);
    self.stop = () => { stopped = true; epoch++; teardown(); };
    self.start = () => { run(); };
    return self;
  }

  window.Net = Net;
  window.Timers = Timers;
})();
