/* Network layer. Players talk through public MQTT brokers over secure WebSockets, which works on almost every
   network (no NAT or relay problems). The earliest present player is the host and referee. Everyone else sends
   to the host and the host broadcasts the shared state. Timing stays fair because every browser syncs its
   clock to the host and measures its own finish from one shared start instant. */
(function () {
  'use strict';
  const now = () => performance.now();
  const te = new TextEncoder(), td = new TextDecoder();

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
    const api = {
      after(ms, fn) {
        const id = ++seq;
        if (!worker) { cbs.set('h' + id, setTimeout(fn, ms)); return id; }
        cbs.set(id, fn); worker.postMessage({ i: id, ms }); return id;
      },
      clear(id) {
        if (!id) return;
        if (!worker) { clearTimeout(cbs.get('h' + id)); cbs.delete('h' + id); return; }
        if (cbs.delete(id)) worker.postMessage({ c: id });
      },
      every(ms, fn) {
        let id, stopped = false;
        const loop = () => { if (stopped) return; fn(); id = api.after(ms, loop); };
        id = api.after(ms, loop);
        return () => { stopped = true; api.clear(id); };
      }
    };
    return api;
  })();

  /* ---------- minimal MQTT 3.1.1 client over WebSocket (QoS 0) ---------- */
  const mstr = (s) => { const b = te.encode(s); const o = new Uint8Array(2 + b.length); o[0] = b.length >> 8; o[1] = b.length & 255; o.set(b, 2); return o; };
  const varint = (n) => { const o = []; do { let d = n % 128; n = Math.floor(n / 128); if (n > 0) d |= 128; o.push(d); } while (n > 0); return Uint8Array.from(o); };
  const cat = (...a) => { let n = 0; for (const x of a) n += x.length; const o = new Uint8Array(n); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
  const packet = (b0, body) => cat(Uint8Array.of(b0), varint(body.length), body);

  function Mqtt(o) { // { url, clientId, keepalive, will: { topic }, onOpen, onClose, onMessage(topic, text, retained) }
    const self = { open: false, url: o.url };
    const subs = new Set();
    let ws = null, buf = new Uint8Array(0), pid = 1, stopPing = null, closed = false, retryT = 0, tries = 0;

    function connect() {
      if (closed) return;
      try { ws = new WebSocket(o.url, 'mqtt'); } catch (_) { return later(); }
      const sock = ws;
      sock.binaryType = 'arraybuffer';
      sock.onopen = () => {
        buf = new Uint8Array(0);
        const flags = 0x02 | (o.will ? 0x04 | 0x20 : 0); // clean session, will (retained)
        sock.send(packet(0x10, cat(mstr('MQTT'), Uint8Array.of(4, flags, o.keepalive >> 8, o.keepalive & 255), mstr(o.clientId + Math.random().toString(36).slice(2, 6)), ...(o.will ? [mstr(o.will.topic), Uint8Array.of(0, 0)] : []))));
      };
      sock.onmessage = (e) => { buf = cat(buf, new Uint8Array(e.data)); parse(sock); };
      sock.onclose = () => { if (ws !== sock) return; if (self.open) { self.open = false; if (o.onClose) o.onClose(); } if (stopPing) { stopPing(); stopPing = null; } later(); };
      sock.onerror = () => {};
    }
    function later() { if (closed) return; clearTimeout(retryT); retryT = setTimeout(connect, Math.min(8000, 700 * Math.pow(1.6, tries++))); }

    function parse(sock) {
      for (;;) {
        if (buf.length < 2) return;
        let len = 0, mul = 1, i = 1, b;
        do { if (i >= buf.length) return; b = buf[i++]; len += (b & 127) * mul; mul *= 128; } while (b & 128 && i < 5);
        if (buf.length < i + len) return;
        const b0 = buf[0], body = buf.subarray(i, i + len);
        buf = buf.slice(i + len);
        const type = b0 >> 4;
        if (type === 2) { // CONNACK
          if (body[1] === 0) {
            tries = 0; self.open = true;
            if (subs.size) sock.send(subscribePacket([...subs]));
            if (!stopPing) stopPing = Timers.every(Math.max(2000, o.keepalive * 500), () => { if (self.open) try { sock.send(Uint8Array.of(0xc0, 0)); } catch (_) {} });
            if (o.onOpen) o.onOpen();
          } else { try { sock.close(); } catch (_) {} }
        } else if (type === 3) { // PUBLISH
          const qos = (b0 >> 1) & 3, tl = (body[0] << 8) | body[1];
          const topic = td.decode(body.subarray(2, 2 + tl));
          const p = 2 + tl + (qos ? 2 : 0);
          if (o.onMessage) o.onMessage(topic, td.decode(body.subarray(p)), !!(b0 & 1));
        }
      }
    }
    function subscribePacket(topics) {
      const id = pid++ & 0xffff || 1;
      return packet(0x82, cat(Uint8Array.of(id >> 8, id & 255), ...topics.map((t) => cat(mstr(t), Uint8Array.of(0)))));
    }
    self.subscribe = (topic) => { subs.add(topic); if (self.open) { try { ws.send(subscribePacket([topic])); } catch (_) {} } };
    self.unsubscribe = (topic) => {
      subs.delete(topic);
      if (self.open) { const id = pid++ & 0xffff || 1; try { ws.send(packet(0xa2, cat(Uint8Array.of(id >> 8, id & 255), mstr(topic)))); } catch (_) {} }
    };
    self.publish = (topic, text, retain) => {
      if (!self.open) return false;
      try { ws.send(packet(0x30 | (retain ? 1 : 0), cat(mstr(topic), te.encode(text)))); return true; } catch (_) { return false; }
    };
    /* close without telling the broker, so it publishes our will (also used to simulate a crash) */
    self.drop = () => { closed = true; clearTimeout(retryT); if (stopPing) { stopPing(); stopPing = null; } self.open = false; try { ws.close(); } catch (_) {} };
    connect();
    return self;
  }

  /* ---------- room ---------- */
  function Net(cfg) {
    const self = { role: null, rtt: null, off: 0, synced: false };
    const emit = (k, ...a) => { if (cfg.on[k]) cfg.on[k](...a); };
    const dbg = (...a) => { if (cfg.debug) console.log('[net ' + Math.round(now()) + ']', ...a); };
    const me = Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 6);
    const P = 'uplevel-spellrace/v1/' + cfg.room;
    const tPres = P + '/p/', tUp = P + '/up', tAll = P + '/dn/all', tMine = P + '/dn/' + me;

    const conns = [];                 // one MQTT connection per broker
    const presence = [];              // per broker: Map id -> { since }
    const seen = new Set(), seenQ = [];
    const guests = new Map();         // host side: client id -> { name, lastSeen, rtt }
    const samples = [];
    const dead = new Map();           // elected ids that never answered, ignored for a while
    let seq = 0, stopped = false, settled = false, mySince = 0, evalT = 0, host = null, joined = false;
    let pendingState = null, helloStop = null, helloStart = 0, pingStop = null, hostChk = null, lastSeen = 0, firstOpen = 0, offlineT = 0;

    const nid = () => me + '.' + (++seq);
    function pub(topic, env, retain) {
      const s = typeof env === 'string' ? env : JSON.stringify(env); // a plain string is sent as is (empty clears a retained message)
      for (const c of conns) c.publish(topic, s, retain);
    }
    const open = () => conns.some((c) => c.open);

    /* ----- presence and election ----- */
    function union() {
      const u = new Map();
      for (const m of presence) for (const [id, v] of m) {
        if (dead.has(id) && dead.get(id) > Date.now() && id !== me) continue;
        const cur = u.get(id); if (!cur || v.since < cur.since) u.set(id, v);
      }
      return u;
    }
    function elected() {
      const u = union(); if (settled && mySince) u.set(me, { since: mySince });
      let best = null, bs = Infinity;
      for (const [id, v] of u) if (v.since < bs || (v.since === bs && id < best)) { best = id; bs = v.since; }
      return best;
    }
    const scheduleEval = () => { if (settled && !evalT) evalT = setTimeout(() => { evalT = 0; evaluate(); }, 120); };

    function evaluate() {
      if (stopped || !settled) return;
      const h = elected();
      if (h === host) return;
      dbg('elected', h, h === me ? '(me)' : '');
      // leaving the previous role
      if (self.role === 'host' && h !== me) stepDown();
      else if (joined) { joined = false; self.role = null; stopGuest(); emit('hostLost'); }
      stopHello(); pendingState = null;
      host = h;
      if (!h) return;
      if (h === me) becomeHost(); else startJoin();
    }

    function stepDown() {
      for (const c of conns) c.unsubscribe(tUp);
      if (hostChk) { hostChk(); hostChk = null; }
      guests.clear(); self.role = null; self.synced = false; self.rtt = null; samples.length = 0;
      emit('hostLost');
    }
    function stopGuest() { if (pingStop) { pingStop(); pingStop = null; } self.synced = false; self.rtt = null; samples.length = 0; }
    function stopHello() { if (helloStop) { helloStop(); helloStop = null; } }

    function becomeHost() {
      self.role = 'host'; joined = false;
      for (const c of conns) c.subscribe(tUp);
      hostChk = Timers.every(1000, () => { for (const [id, g] of guests) if (now() - g.lastSeen > 7000) { guests.delete(id); emit('guestLeft', g.name); } });
      emit('role', 'host'); emit('status', 'online');
    }

    function startJoin() {
      helloStart = now();
      const hello = () => {
        if (!host || host === me || joined) return;
        if (now() - helloStart > 8000) { dead.set(host, Date.now() + 300000); dbg('host never answered, ignoring', host); stopHello(); host = null; scheduleEval(); return; }
        pub(tUp, { i: nid(), f: me, m: { t: 'hello', name: cfg.name } });
      };
      hello();
      helloStop = Timers.every(1000, hello);
    }

    /* ----- messages ----- */
    function onMessage(k, topic, text) {
      if (topic.startsWith(tPres)) {
        const id = topic.slice(tPres.length);
        if (!text) presence[k].delete(id);
        else { try { presence[k].set(id, JSON.parse(text)); } catch (_) { return; } }
        scheduleEval();
        return;
      }
      let env; try { env = JSON.parse(text); } catch (_) { return; }
      if (!env || !env.m || !env.f || env.f === me) return;
      if (seen.has(env.i)) return;
      seen.add(env.i); seenQ.push(env.i); if (seenQ.length > 600) seen.delete(seenQ.shift());
      if (topic === tUp) { if (self.role === 'host') fromGuest(env); return; }
      if (env.x === me) return;
      if (env.f !== host) return; // only the elected host speaks to us
      fromHost(env.m);
    }

    function fromGuest(env) {
      const m = env.m, f = env.f; let g = guests.get(f);
      if (m.t === 'hello') {
        if (g) { g.lastSeen = now(); sendTo(f, { t: 'welcome', name: g.name }); emit('rejoined', g.name); return; }
        for (const [oid, og] of guests) { // a returning player whose old link went quiet
          if (String(m.name || '').toLowerCase() === og.name.toLowerCase() && now() - og.lastSeen > 3000) { guests.delete(oid); emit('guestLeft', og.name); }
        }
        if (guests.size >= cfg.max - 1) { sendTo(f, { t: 'reject', why: 'full' }); return; }
        emit('hello', m, (ok, why, extra) => {
          if (!ok) { sendTo(f, { t: 'reject', why }); return; }
          guests.set(f, { name: (extra && extra.name) || m.name, lastSeen: now(), rtt: null });
          sendTo(f, Object.assign({ t: 'welcome' }, extra || {}));
        });
        return;
      }
      if (!g) return;
      g.lastSeen = now();
      if (m.t === 'ping') { g.rtt = m.rtt; sendTo(f, { t: 'pong', c: m.c, h: now() }); emit('rtt'); return; }
      emit('msg', m, g.name);
    }

    function fromHost(m) {
      lastSeen = now();
      if (!joined) {
        if (m.t === 'welcome') {
          joined = true; stopHello(); self.role = 'guest'; lastSeen = now();
          startPings();
          emit('welcome', m); emit('role', 'guest'); emit('status', 'online');
          if (pendingState) { const ps = pendingState; pendingState = null; emit('msg', ps); }
        } else if (m.t === 'state') pendingState = m;
        else if (m.t === 'reject') { stopped = true; stopHello(); emit('rejected', m.why); self.stop(); }
        return;
      }
      if (m.t === 'pong') { onPong(m); return; }
      emit('msg', m);
    }

    function startPings() {
      let burst = 0;
      const ping = () => pub(tUp, { i: nid(), f: me, m: { t: 'ping', c: now(), rtt: self.rtt } });
      ping();
      const fast = setInterval(() => { ping(); if (++burst >= 10) clearInterval(fast); }, 150);
      const slow = Timers.every(1000, () => {
        ping();
        if (joined && now() - lastSeen > 6000) { // host went quiet: wait for the election to settle or for it to come back
          joined = false; self.role = null; stopGuest(); emit('hostLost'); startJoin();
        }
      });
      pingStop = () => { clearInterval(fast); slow(); };
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

    function sendTo(id, m) { pub(P + '/dn/' + id, { i: nid(), f: me, m }); }

    /* ----- brokers ----- */
    function startBrokers() {
      cfg.brokers.forEach((url, k) => {
        presence[k] = new Map();
        const c = Mqtt({
          url, clientId: 'sr-' + me + '-' + k, keepalive: 6, will: { topic: tPres + me },
          onOpen() {
            dbg('broker up', url);
            c.subscribe(tPres + '+'); c.subscribe(tAll); c.subscribe(tMine);
            if (self.role === 'host') c.subscribe(tUp);
            if (self.role) emit('status', 'online'); else if (firstOpen) emit('status', 'connecting');
            if (settled && mySince) c.publish(tPres + me, JSON.stringify({ since: mySince, n: cfg.name }), true);
            if (!firstOpen) {
              firstOpen = Date.now(); clearTimeout(offlineT);
              emit('status', 'connecting');
              setTimeout(settle, 900); // collect everyone's retained presence before choosing a place in line
            }
          },
          onClose() { dbg('broker down', url); presence[k].clear(); if (!stopped && !open()) emit('status', 'offline'); },
          onMessage: (topic, text) => onMessage(k, topic, text)
        });
        conns.push(c);
      });
      offlineT = setTimeout(() => { if (!firstOpen && !stopped) emit('status', 'offline'); }, 7000);
    }

    function settle() {
      if (stopped || settled) return;
      let max = 0;
      for (const m of presence) for (const v of m.values()) if (v.since > max) max = v.since;
      mySince = Math.max(Date.now(), max + 1); // always behind whoever is already here
      pub(tPres + me, { since: mySince, n: cfg.name }, true);
      setTimeout(() => { settled = true; evaluate(); }, 350);
    }

    self.send = (m) => { if (joined) pub(tUp, { i: nid(), f: me, m }); };
    self.sendAll = (m, exceptName) => {
      let x; if (exceptName) for (const [id, g] of guests) if (g.name === exceptName) x = id;
      pub(tAll, { i: nid(), f: me, x, m });
    };
    self.guestCount = () => guests.size;
    self.maxPeerRtt = () => { let r = null; for (const g of guests.values()) if (g.rtt != null && (r == null || g.rtt > r)) r = g.rtt; return r; };
    self.toLocal = (hostT) => (self.role === 'host' ? hostT : hostT - self.off);
    self.hostNow = () => (self.role === 'host' ? now() : now() + self.off);
    function shutdown(clear) {
      stopped = true; clearTimeout(evalT); clearTimeout(offlineT); stopHello(); stopGuest();
      if (hostChk) { hostChk(); hostChk = null; }
      if (clear) pub(tPres + me, '', true);
      for (const c of conns) c.drop();
      conns.length = 0; guests.clear(); self.role = null;
    }
    self.stop = () => shutdown(true);
    self.crash = () => shutdown(false); // test hook: vanish without cleaning up
    self.start = () => startBrokers();
    self.id = me;
    return self;
  }

  window.Net = Net;
  window.Timers = Timers;
})();
