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

  frame(idx, fi, fn, params) {
    const f = new Uint8Array(19); f[0] = idx; f[1] = fi; f[2] = (fn << 4) | SW;
    if (params) f.set(params.slice(0, 16), 3);
    return f;
  }

  request(idx, fi, fn, params = [], timeout = 1500) {
    const run = () => new Promise((resolve, reject) => {
      const fsw = (fn << 4) | SW;
      const timer = setTimeout(() => { this.waiters.delete(idx); reject(new Error("timeout")); }, timeout);
      this.waiters.set(idx, { fi, fsw,
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); } });
      this.hid.sendReport(R_LONG, this.frame(idx, fi, fn, params))
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
  }
  get isKeyboard() { return /\bK\d|Keys/i.test(this.name); }
  req(fi, fn, params, t) { return this.link.request(this.index, fi, fn, params, t); }

  async init() {
    this.changeHost = await this.featureIndex(FEAT_CHANGE_HOST);
    const r = await this.req(this.changeHost, 0);
    this.hosts = r[0]; this.current = r[1];
    try { this.name = await this.readName(); } catch {}
    try { this.hostNames = await this.readHostNames(); } catch { this.hostNames = []; }
  }
  /** HOSTS_INFO 0x1815: fn1 getHostInfo(h) -> [h, status, bus, pages, nameLen, max];
   *  fn3 getHostFriendlyName(h, offset) -> [h, offset, 14 bytes UTF-8]. */
  async readHostNames() {
    const fi = await this.featureIndex(FEAT_HOSTS_INFO);
    const names = [];
    for (let h = 0; h < this.hosts; h++) {
      const len = (await this.req(fi, 1, [h]))[4];
      const bytes = [];
      while (bytes.length < len) {
        const r = await this.req(fi, 3, [h, bytes.length]);
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


// Name-based target: which channel (in the STAYING device's numbering) holds
// the computer the other device just went to. Mirrors FollowPolicy.ResolveTarget
// in logi-sync.ps1.
const sameName = (a, b) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
function resolveTarget(stay, gone, learned) {
  const names = stay.hostNames || [], here = names[stay.current];
  const other12 = { channel: stay.current + 1 === 1 ? 2 : 1, dest: null };
  if (!here) return { ...other12, why: "device doesn't report computer names: other of 1/2" };
  // 1. Mouse buttons cycle to the next channel, so we know exactly where it went.
  if (gone && !gone.isKeyboard && gone.hosts > 0 && gone.current >= 0) {
    const next = (gone.hostNames || [])[(gone.current + 1) % gone.hosts];
    const i = names.findIndex((n, j) => j !== stay.current && sameName(n, next) && !sameName(next, here));
    if (i >= 0) return { channel: i + 1, dest: names[i], why: `mouse button moves to the next channel: ${names[i]}` };
  }
  // 2. Other computers this device knows, preferring ones the other device knows too.
  let cands = names.map((n, i) => i).filter((i) => i !== stay.current && names[i] && !sameName(names[i], here));
  const goneNames = (gone && gone.hostNames) || [];
  const both = cands.filter((i) => goneNames.some((n) => sameName(n, names[i])));
  if (both.length) cands = both;
  if (!cands.length) return { ...other12, why: "no other computer paired: other of 1/2" };
  if (cands.length === 1) return { channel: cands[0] + 1, dest: names[cands[0]], why: `the only other computer: ${names[cands[0]]}` };
  const l = cands.find((i) => sameName(names[i], learned));
  if (l !== undefined) return { channel: l + 1, dest: names[l], why: `where you went last time: ${names[l]}` };
  return { channel: cands[0] + 1, dest: names[cands[0]], why: `lowest other channel (no history yet): ${names[cands[0]]}` };
}
let lastGone = null;   // the device that most recently left (keeps its channel table)
function targetFor(dev) {
  const fixed = settings().target;
  if (fixed) return { channel: fixed, why: "fixed target" };
  const r = resolveTarget(dev, lastGone, store.get("lastComputer", null));
  if (r.dest) store.set("lastComputer", r.dest);
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
