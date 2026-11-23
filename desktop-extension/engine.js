// logi-sync engine: runs in the extension's hidden offscreen document.
// Same HID++ code and follow rule as web/logi-sync.html, without any UI.
// Talks to the settings page through localStorage (shared extension origin)
// and a BroadcastChannel.
"use strict";
const LOGI = 0x046d;
const UP_BLE = 0xff43;        // Bluetooth-direct HID++ collection
const UP_RECEIVER = 0xff00;   // Bolt / Unifying receiver HID++ collection
const R_SHORT = 0x10, R_LONG = 0x11, SW = 0x0e;
const FEAT_CHANGE_HOST = 0x1814, FEAT_NAME = 0x0005, FEAT_HOSTS_INFO = 0x1815;
let swSeq = 0;
const nextSw = () => 2 + (++swSeq & 7);   // ids 2..9
const MARKER = 0x4c;   // Easy-Switch cookie meaning "logi-sync runs on this channel"

const store = {
  get(k, d) { try { const v = localStorage.getItem("logi-sync:" + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("logi-sync:" + k, JSON.stringify(v)); } catch {} },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (n, w = 4) => n.toString(16).padStart(w, "0");
const settings = () => ({
  target: Number(store.get("target", 0)),
  delayMs: Math.max(300, Number(store.get("delay", 1)) * 1000),
  enabled: store.get("enabled", true) !== false,
});

function log(msg) {
  const lines = store.get("log", []);
  lines.unshift(`${new Date().toLocaleString()} ${msg}`);
  lines.length = Math.min(lines.length, 300);
  store.set("log", lines);
}

// ----------------------------------------------------------------- link
class Link {
  constructor(hid) {
    this.hid = hid;
    this.isReceiver = hid.collections.some((c) => c.usagePage === UP_RECEIVER);
    this.waiters = new Map();
    this.queues = new Map();
    this.onNotify = null;
    this.handler = (e) => this.handle(e);
  }
  async open() { if (!this.hid.opened) await this.hid.open(); this.hid.addEventListener("inputreport", this.handler); }

  handle(e) {
    if (e.reportId !== R_SHORT && e.reportId !== R_LONG) return;
    const d = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength);
    const idx = d[0];
    if (this.isReceiver && e.reportId === R_SHORT && d[1] === 0x41 && this.onNotify) {
      this.onNotify(idx, (d[3] & 0x40) === 0);   // bit 6 set = link not established
      return;
    }
    const w = this.waiters.get(idx);
    if (!w) return;
    const done = (fn, v) => { this.waiters.delete(idx); fn(v); };
    if (d[1] === w.fi && d[2] === w.fsw) done(w.resolve, d.slice(3));
    else if (d[1] === 0xff && d[2] === w.fi && d[3] === w.fsw) done(w.reject, new Error("device error 0x" + hex(d[4], 2)));
    else if (d[1] === 0x8f && d[2] === w.fi && d[3] === w.fsw) done(w.reject, new Error("unreachable (0x" + hex(d[4], 2) + ")"));
  }

  frame(idx, fi, fn, params, sw = SW) {
    const f = new Uint8Array(19); f[0] = idx; f[1] = fi; f[2] = (fn << 4) | sw;
    if (params) f.set(params.slice(0, 16), 3);
    return f;
  }

  request(idx, fi, fn, params = [], timeout = 1500) {
    const run = () => new Promise((resolve, reject) => {
      // A different software id per request: a late reply to an earlier
      // (timed-out) request can't be mistaken for this one's.
      const sw = nextSw();
      const fsw = (fn << 4) | sw;
      const timer = setTimeout(() => { this.waiters.delete(idx); reject(new Error("timeout")); }, timeout);
      this.waiters.set(idx, { fi, fsw,
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); } });
      this.hid.sendReport(R_LONG, this.frame(idx, fi, fn, params, sw))
        .catch((e) => { clearTimeout(timer); this.waiters.delete(idx); reject(e); });
    });
    const p = (this.queues.get(idx) || Promise.resolve()).then(run, run);
    this.queues.set(idx, p.catch(() => {}));
    return p;
  }

  post(idx, fi, fn, params) { return this.hid.sendReport(R_LONG, this.frame(idx, fi, fn, params)); }

  enableNotifications() {
    return this.hid.sendReport(R_SHORT, new Uint8Array([0xff, 0x80, 0x00, 0x00, 0x09, 0x00])).catch(() => {});
  }
}

// --------------------------------------------------------------- device
class Hidpp {
  constructor(link, index) {
    this.link = link; this.index = index;
    this.pid = link.hid.productId;
    this.key = link.isReceiver ? `rx${hex(this.pid)}:${index}` : `bt${hex(this.pid)}`;
    this.name = link.hid.productName || "Logitech " + hex(this.pid);
    this.hosts = 0; this.current = -1; this.changeHost = 0;
    this.hostNames = [];   // computer name per channel ("" = empty); [] if unsupported
    this.participants = []; // channels marked as running logi-sync (Easy-Switch cookie)
    this.connectedAt = Date.now(); this.marked = false;
  }
  get isKeyboard() { return /\bK\d|Keys/i.test(this.name); }
  req(fi, fn, params, t) { return this.link.request(this.index, fi, fn, params, t); }

  async init() {
    this.changeHost = await this.featureIndex(FEAT_CHANGE_HOST);
    const r = await this.req(this.changeHost, 0);
    this.hosts = r[0]; this.current = r[1];
    try { this.name = await this.readName(); } catch {}
    // Right after a reconnect the device is busy, so retry and fall back to the last good read.
    for (let a = 0; a < 3 && !this.hostNames.length; a++) {
      try { this.hostNames = await this.readHostNames(); }
      catch (e) { if (/not supported/.test(e.message)) break; await sleep(400); }   // retry only if busy
    }
    if (this.hostNames.length) store.set("names:" + this.key, this.hostNames);
    else {
      const cached = store.get("names:" + this.key, []);
      if (cached.length === this.hosts) this.hostNames = cached;
    }
    try { await this.readMarks(); } catch {}
  }
  /** CHANGE_HOST fn2 getCookies -> a byte per channel; fn3 setCookie(host, value). */
  async readMarks() {
    const c = [...(await this.req(this.changeHost, 2))];
    this.participants = c.slice(0, this.hosts).map((v) => v === MARKER);
    this.marked = !!this.participants[this.current];
  }
  /** Mark this channel as running logi-sync, only once the device has stayed
   *  connected for `stableMs` and still reports the same channel. (While you
   *  cycle the mouse button it touches each computer briefly and may already
   *  report the NEXT channel: marking then put a mark on the iPad's channel.)
   *  Returns true if it wrote the mark. */
  async tryMarkIfStable(stableMs) {
    if (this.marked || Date.now() - this.connectedAt < stableMs) return false;
    const before = this.current;
    const r = await this.req(this.changeHost, 0);
    if (r[1] !== before) { this.marked = true; return false; }   // it's leaving; never mark
    const c = await this.req(this.changeHost, 2);
    if (c[before] !== MARKER) await this.req(this.changeHost, 3, [before, MARKER]);
    await this.readMarks();
    this.marked = true;
    return true;
  }
  /** HOSTS_INFO 0x1815: fn1 getHostInfo(h) -> [h, status, bus, pages, nameLen, max];
   *  fn3 getHostFriendlyName(h, offset) -> [h, offset, 14 bytes UTF-8]. */
  async readHostNames() {
    const fi = await this.featureIndex(FEAT_HOSTS_INFO);
    const names = [];
    for (let h = 0; h < this.hosts; h++) {
      const info = await this.req(fi, 1, [h]);
      if (info[0] !== h) throw new Error("host info reply for wrong channel");
      const len = info[4];
      const bytes = [];
      while (bytes.length < len) {
        const r = await this.req(fi, 3, [h, bytes.length]);
        // A late reply to an earlier request would otherwise be read as this one.
        if (r[0] !== h || r[1] !== bytes.length) throw new Error("host name reply out of order");
        const take = Math.min(14, len - bytes.length);
        for (let i = 0; i < take; i++) bytes.push(r[2 + i]);
      }
      names.push(new TextDecoder().decode(new Uint8Array(bytes)).replace(/\0+$/, "").trim());
    }
    return names;
  }
  async featureIndex(id) {
    const r = await this.req(0, 0, [id >> 8, id & 0xff]);
    if (!r[0]) throw new Error("feature 0x" + hex(id) + " not supported");
    return r[0];
  }
  async readName() {
    const fi = await this.featureIndex(FEAT_NAME);
    const len = (await this.req(fi, 0))[0];
    let s = "";
    while (s.length < len) {
      const c = await this.req(fi, 1, [s.length]);
      for (let i = 0; i < 16 && s.length < len; i++) s += String.fromCharCode(c[i]);
    }
    return s.replace(/\0+$/, "");
  }
  switchTo(ch) {
    if (ch < 1 || ch > this.hosts) throw new Error(`${this.name} has ${this.hosts} channels`);
    return this.link.post(this.index, this.changeHost, 1, [ch - 1]);
  }
}

// --------------------------------------------------------------- policy
const devices = new Map();   // key -> Hidpp
const lostAt = new Map();    // key -> ms
let lastChecked = 0;

function publish() {
  const known = store.get("known", {});
  for (const d of devices.values()) known[d.key] = d.name;
  store.set("known", known);
  store.set("state", {
    at: Date.now(),
    checked: lastChecked,
    btDirect: [...links.values()].some((l) => !l.isReceiver),
    receivers: [...links.values()].filter((l) => l.isReceiver).map((l) => l.hid.productName || hex(l.hid.productId)),
    devices: [...devices.values()].map((d) => ({ key: d.key, name: d.name, channel: d.current + 1, hosts: d.hosts })),
  });
}

function onFound(dev) {
  devices.set(dev.key, dev); lostAt.delete(dev.key);
  log(`connected: ${dev.name}, channel ${dev.current + 1}/${dev.hosts}`);
  publish();
}

// follow=false: we only noticed late (missed event), so don't drag the other device.
function onLost(key, follow = true) {
  const dev = devices.get(key);
  if (!dev) return;
  devices.delete(key);
  lastGone = dev;
  log(follow ? `disconnected: ${dev.name}` : `noticed ${dev.name} is gone (missed event, not following)`);
  const s = settings();
  if (follow && devices.size > 0 && s.enabled) {
    lostAt.set(key, Date.now());
    setTimeout(tick, s.delayMs + 30);
  }
  publish();
}

function tick() {
  const now = Date.now(), { delayMs } = settings();
  if (![...lostAt.values()].some((t) => now - t >= delayMs - 50)) return;
  lostAt.clear();
  for (const dev of [...devices.values()]) follow(dev);
}


// Which channel (in the STAYING device's numbering) to send the staying device
// to. Only channels running logi-sync are targets once any are known: a device
// sent anywhere else (an iPad) is stranded, because nothing there sends the
// other one back. Mirrors FollowPolicy.ResolveTarget in logi-sync.ps1.
const sameName = (a, b) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
function resolveTarget(stay, gone, learned) {
  const sn = stay.hostNames || [], sp = stay.participants || [], here = stay.current;
  const gn = (gone && gone.hostNames) || [], gp = (gone && gone.participants) || [];
  const label = (i) => sn[i] || `channel ${i + 1}`;
  const othersMarked = (arr, except) => arr.some((v, i) => v && i !== except);
  const namesBoth = !!sn[here] && gn.length > 0;
  const toStay = (gc) => {
    if (namesBoth) return sn.findIndex((n, i) => i !== here && sameName(n, gn[gc]));
    return gc !== here ? gc : -1;
  };
  // 1. Mouse-led: walk its button's cycle to the first channel running logi-sync.
  if (gone && !gone.isKeyboard && gone.hosts > 1 && gone.current >= 0) {
    const marksKnown = othersMarked(gp, gone.current);
    for (let step = 1; step < gone.hosts; step++) {
      const gc = (gone.current + step) % gone.hosts;
      if (marksKnown && !gp[gc]) continue;
      const sc = toStay(gc);
      if (sc < 0) break;
      if (marksKnown && othersMarked(sp, here) && !sp[sc]) continue;   // both devices must agree
      return { channel: sc + 1, dest: sn[sc] || null, certain: true,
        why: step === 1 ? `mouse moved to the next channel: ${label(sc)}`
                        : `mouse button passes ${step - 1} channel(s) not running logi-sync; next one running it: ${label(sc)}` };
    }
  }
  // 2. Candidates: channels running logi-sync, else other paired computers.
  let cands, basis;
  // The gone device's mark for the same computer (matched by name when possible).
  const goneMarked = (sc) => (namesBoth ? !!gp[gn.findIndex((n) => sameName(n, sn[sc]))] : !!gp[sc]);
  const goneMarksKnown = gone ? othersMarked(gp, gone.current) : false;
  cands = [];
  if (othersMarked(sp, here)) {
    // Both devices must carry the mark: one stray mark can't make a tablet a target.
    cands = sp.map((v, i) => (v && i !== here && (!goneMarksKnown || goneMarked(i)) ? i : -1)).filter((i) => i >= 0);
    basis = "running logi-sync";
  }
  if (!cands.length) {
    cands = sn[here] ? sn.map((n, i) => i).filter((i) => i !== here && sn[i] && !sameName(sn[i], sn[here])) : [];
    const both = cands.filter((i) => gn.some((n) => sameName(n, sn[i])));
    if (both.length) cands = both;
    basis = "paired (no logi-sync marks seen yet)";
  }
  if (!cands.length) return { channel: here + 1 === 1 ? 2 : 1, dest: null, certain: false, why: "nothing else known: other of 1/2" };
  if (cands.length === 1) return { channel: cands[0] + 1, dest: sn[cands[0]] || null, certain: basis === "running logi-sync", why: `the only other computer ${basis}: ${label(cands[0])}` };
  const l = cands.find((i) => sameName(sn[i], learned));
  if (l !== undefined) return { channel: l + 1, dest: sn[l] || null, certain: false, why: `last computer you went to (${basis}): ${label(l)}` };
  return { channel: cands[0] + 1, dest: sn[cands[0]] || null, certain: false, why: `lowest other channel ${basis}: ${label(cands[0])}` };
}

let lastGone = null;   // the device that most recently left (keeps its channel table)
function targetFor(dev) {
  const fixed = settings().target;
  if (fixed) return { channel: fixed, why: "fixed target" };
  const r = resolveTarget(dev, lastGone, store.get("lastComputer2", null));
  if (r.certain && r.dest) store.set("lastComputer2", r.dest);   // never learn from a guess
  return r;
}

async function follow(dev) {
  const { channel: ch, why } = targetFor(dev);
  log(`following: sending ${dev.name} to channel ${ch} (${why})`);
  try { await dev.switchTo(ch); } catch (e) { log(`switch failed for ${dev.name}: ${e.message}`); }
}

async function switchAll(ch) {
  const list = [...devices.values()].sort((a, b) => a.isKeyboard - b.isKeyboard); // keyboard last
  if (!list.length) log("send both: no devices connected here");
  for (const d of list) {
    try { await d.switchTo(ch); log(`sent ${d.name} to channel ${ch}`); } catch (e) { log(`switch failed for ${d.name}: ${e.message}`); }
    await sleep(50);
  }
}

// ------------------------------------------------------------ plumbing
const links = new Map();       // HIDDevice -> Link
const isHidpp = (h) => h.vendorId === LOGI && h.collections.some((c) => c.usagePage === UP_BLE || c.usagePage === UP_RECEIVER);
const pending = new Set();

async function attachDevice(link, index, attempts = 5) {
  const probe = new Hidpp(link, index);
  if (devices.has(probe.key) || pending.has(probe.key)) return;
  pending.add(probe.key);
  try {
    for (let i = 0; i < attempts; i++) {
      try { await probe.init(); onFound(probe); return; }
      catch (e) {
        if (/not supported/.test(e.message)) { if (!link.isReceiver) log(`${probe.name}: no Easy-Switch, ignored`); return; }
        if (link.isReceiver && /unreachable/.test(e.message)) return;
        await sleep(700);
      }
    }
    if (!link.isReceiver) log(`${probe.name} not answering yet, will retry`);
  } finally { pending.delete(probe.key); }
}

function dropLink(hid) {
  const link = links.get(hid);
  if (link) hid.removeEventListener("inputreport", link.handler);
  links.delete(hid);
  hid.close().catch(() => {});
}

async function attach(hid) {
  if (!isHidpp(hid) || links.has(hid)) return;
  const link = new Link(hid);
  links.set(hid, link);
  try { await link.open(); } catch (e) { links.delete(hid); log(`could not open ${hid.productName}: ${e.message}`); return; }
  if (!link.isReceiver) {
    await attachDevice(link, 0xff);
    if (!devices.has(`bt${hex(hid.productId)}`)) dropLink(hid);
    publish();
    return;
  }
  log(`receiver found: ${hid.productName || hex(hid.productId)}`);
  link.onNotify = (idx, up) => {
    if (up) setTimeout(() => attachDevice(link, idx), 300);
    else onLost(`rx${hex(hid.productId)}:${idx}`);
  };
  await link.enableNotifications();
  for (let idx = 1; idx <= 6; idx++) await attachDevice(link, idx, 2);
  publish();
}

function detach(hid) {
  const link = links.get(hid);
  if (!link) return;
  links.delete(hid);
  for (const dev of [...devices.values()]) if (dev.link === link) onLost(dev.key);
}

let reconciling = false, lastReceiverProbe = 0;
async function reconcile() {
  if (reconciling) return;
  reconciling = true;
  try {
    const present = await navigator.hid.getDevices();
    for (const dev of [...devices.values()]) {
      if (!present.includes(dev.link.hid) || !dev.link.hid.opened) onLost(dev.key, false);
    }
    for (const hid of [...links.keys()]) if (!present.includes(hid)) links.delete(hid);
    for (const h of present) if (isHidpp(h) && !links.has(h)) await attach(h);
    for (const d of [...devices.values()]) {
      try { if (await d.tryMarkIfStable(5000)) log(`marked channel ${d.current + 1} as running logi-sync on ${d.name}`); } catch {}
    }
    if (Date.now() - lastReceiverProbe > 10000) {
      lastReceiverProbe = Date.now();
      for (const link of [...links.values()]) {
        if (!link.isReceiver) continue;
        for (let idx = 1; idx <= 6; idx++) await attachDevice(link, idx, 1);
      }
    }
    lastChecked = Date.now();
    publish();
  } catch (e) {
    log("re-check failed: " + e.message);
  } finally { reconciling = false; }
}

async function init() {
  if (!("hid" in navigator)) { log("this browser has no WebHID: logi-sync can't run"); return; }
  const bus = new BroadcastChannel("logi-sync");
  bus.onmessage = (e) => {
    const m = e.data || {};
    if (m.cmd === "switch") switchAll(Number(m.ch));
    if (m.cmd === "rescan") reconcile();
  };
  navigator.hid.addEventListener("connect", (e) => attach(e.device));
  navigator.hid.addEventListener("disconnect", (e) => detach(e.device));
  for (const h of await navigator.hid.getDevices()) await attach(h);
  log(`engine started (${devices.size} device(s) here)`);
  lastChecked = Date.now();
  publish();
  setInterval(reconcile, 5000);
}
init();
