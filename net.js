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

  function Net(cfg) {
    const self = { role: null, rtt: null, off: 0, synced: false };
    let peer = null, conn = null, stopped = false, stopPing = null, lastSeen = 0, epoch = 0;
    const samples = [];
    const guests = new Map(); // host side: connection -> { name, lastSeen, rtt }
    const emit = (k, ...a) => { if (cfg.on[k]) cfg.on[k](...a); };

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

    async function run() {
      const my = ++epoch;
      let attempt = 0;
      while (!stopped && my === epoch) {
        emit('status', 'connecting');
        let p = null;
        try { p = await mkPeer(cfg.hostId); }
        catch (e) {
          if (!e || e.type !== 'unavailable-id') {
            emit('status', 'offline');
            await sleep(Math.min(4000, 900 + attempt * 600)); attempt++; continue;
          }
        }
        if (stopped || my !== epoch) { if (p) try { p.destroy(); } catch (_) {} return; }
        if (p) { becomeHost(p); return; }
        const r = await tryGuest(my);
        if (r === 'ok' || r === 'stop') return;
        await sleep(600 + Math.random() * 600); attempt++;
      }
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
        for (const [c, g] of guests) if (now() - g.lastSeen > 9000) dropGuest(c, true);
      });
      emit('role', 'host'); emit('status', 'online');
    }

    function tryGuest(my) {
      return new Promise(async (resolve) => {
        let p;
        try { p = await mkPeer(null); } catch (e) { resolve('retry'); return; }
        if (stopped || my !== epoch) { try { p.destroy(); } catch (_) {} resolve('stop'); return; }
        let settled = false, joined = false;
        const c = p.connect(cfg.hostId, { reliable: true, serialization: 'json' });
        const bail = (r) => { if (settled) return; settled = true; clearTimeout(timer); try { c.close(); } catch (_) {} try { p.destroy(); } catch (_) {} resolve(r); };
        const timer = setTimeout(() => bail('retry'), 7000);
        p.on('error', () => { if (!joined) bail('retry'); });
        c.on('open', () => { try { c.send({ t: 'hello', name: cfg.name }); } catch (_) {} });
        c.on('data', (m) => {
          if (!m || typeof m !== 'object') return;
          if (!joined) {
            if (m.t === 'welcome') {
              joined = true; settled = true; clearTimeout(timer);
              peer = p; conn = c; self.role = 'guest'; lastSeen = now();
              startGuestPings();
              emit('welcome', m);
              emit('role', 'guest'); emit('status', 'online');
              resolve('ok');
            } else if (m.t === 'reject') {
              settled = true; clearTimeout(timer); try { c.close(); } catch (_) {} try { p.destroy(); } catch (_) {}
              stopped = true; emit('rejected', m.why); resolve('stop');
            }
            return;
          }
          lastSeen = now();
          if (m.t === 'pong') { onPong(m); return; }
          emit('msg', m);
        });
        const lost = () => { if (joined) hostLost(c); else bail('retry'); };
        c.on('close', lost); c.on('error', lost);
      });
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
        if (conn && now() - lastSeen > 9000) hostLost(conn);
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
