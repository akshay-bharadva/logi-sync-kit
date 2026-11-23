// Simulation test for extension/engine.js: fake WebHID (Bluetooth-direct and a
// receiver with two paired devices), fake localStorage and BroadcastChannel.
// Run: node tests/ext-engine.test.js
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const engineSrc = fs.readFileSync(path.join(__dirname, "..", "desktop-extension", "engine.js"), "utf8");

/** A HID++ 2.0 device answering on `idx`: ChangeHost at feature 10, name at 5. */
class FakeDev {
  constructor(name, host = 0) { this.name = name; this.host = host; this.switchedTo = null; this.online = true; this.busy = 0; }
  answer(fi, fn, data) {
    if (fi === 0 && fn === 0) { const id = (data[3] << 8) | data[4]; return [id === 0x1814 ? 10 : id === 0x0005 ? 5 : 0]; }
    if (fi === 10 && fn === 0) return [3, this.host];
    if (fi === 10 && fn === 1) { this.switchedTo = data[3] + 1; return null; }
    if (fi === 5 && fn === 0) return [this.name.length];
    if (fi === 5 && fn === 1) return [...this.name.slice(data[3], data[3] + 16)].map((c) => c.charCodeAt(0));
    return null;
  }
}

class FakeHid {
  /** slots: Map index -> FakeDev. Receiver if usagePage 0xff00. */
  constructor(pid, productName, usagePage, slots) {
    this.vendorId = 0x046d; this.productId = pid; this.productName = productName;
    this.collections = [{ usagePage, usage: usagePage === 0xff00 ? 2 : 0x0202 }];
    this.slots = slots; this.opened = false; this.listeners = []; this.notificationsOn = false;
  }
  async open() { this.opened = true; }
  async close() { this.opened = false; }
  addEventListener(t, fn) { if (t === "inputreport") this.listeners.push(fn); }
  removeEventListener(t, fn) { this.listeners = this.listeners.filter((f) => f !== fn); }
  emit(reportId, bytes) {
    const out = new Uint8Array(reportId === 0x10 ? 6 : 19); out.set(bytes);
    setTimeout(() => this.listeners.forEach((f) => f({ reportId, data: new DataView(out.buffer) })), 3);
  }
  async sendReport(reportId, data) {
    if (!this.opened) throw new Error("not opened");
    if (reportId === 0x10) { if (data[1] === 0x80 && data[2] === 0x00) this.notificationsOn = true; return; }
    const [idx, fi, fsw] = data, dev = this.slots.get(idx);
    if (!dev || !dev.online) {                               // receiver: device not reachable
      if (this.collections[0].usagePage === 0xff00) this.emit(0x10, [idx, 0x8f, fi, fsw, 0x09]);
      return;
    }
    if (dev.busy > 0) { dev.busy--; return; }
    const reply = dev.answer(fi, fsw >> 4, data);
    if (reply) this.emit(0x11, [idx, fi, fsw, ...reply]);
  }
  /** Receiver: simulate the device's radio link going up or down. */
  link(idx, up) { this.slots.get(idx).online = up; this.emit(0x10, [idx, 0x41, 0x04, up ? 0x00 : 0x40, 0, 0]); }
}

function startEngine(present) {
  const storage = {};
  const channels = [];
  class FakeBC { constructor() { channels.push(this); } postMessage() {} }
  const hidListeners = { connect: [], disconnect: [] };
  const hid = {
    present,
    async getDevices() { return this.present.slice(); },
    addEventListener(t, fn) { hidListeners[t].push(fn); },
    fire(t, device) { hidListeners[t].forEach((f) => f({ device })); },
  };
  const ctx = {
    console, setTimeout, clearTimeout, setInterval, Date, Promise, Map, Set, Uint8Array, DataView, JSON, Math, Number, String, Error, Object,
    localStorage: { getItem: (k) => (k in storage ? storage[k] : null), setItem: (k, v) => (storage[k] = String(v)) },
    navigator: { hid },
    BroadcastChannel: FakeBC,
  };
  vm.createContext(ctx);
  vm.runInContext(engineSrc, ctx);
  const get = (k) => JSON.parse(storage["logi-sync:" + k] || "null");
  return {
    hid,
    log: () => (get("log") || []).join("\n"),
    state: () => get("state"),
    send: (msg) => channels.forEach((c) => c.onmessage && c.onmessage({ data: msg })),
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log("ok   " + name); }
  catch (e) { failed++; console.log("FAIL " + name + "\n     " + e.message); }
}

(async () => {
  await test("receiver: both paired devices found, notifications enabled", async () => {
    const kb = new FakeDev("Signature Slim K950", 1), ms = new FakeDev("Signature Plus M750 L", 1);
    const rx = new FakeHid(0xc548, "USB Receiver", 0xff00, new Map([[1, kb], [2, ms]]));
    const e = startEngine([rx]);
    await wait(1500);
    assert.ok(rx.notificationsOn, "notifications not enabled");
    assert.strictEqual(e.state().devices.length, 2, e.log());
    assert.strictEqual(e.state().devices[0].channel, 2);
  });

  await test("receiver: keyboard link drops -> mouse follows to channel 1", async () => {
    const kb = new FakeDev("Signature Slim K950", 1), ms = new FakeDev("Signature Plus M750 L", 1);
    const rx = new FakeHid(0xc548, "USB Receiver", 0xff00, new Map([[1, kb], [2, ms]]));
    const e = startEngine([rx]);
    await wait(1500);
    rx.link(1, false);
    await wait(1300);
    assert.strictEqual(ms.switchedTo, 1, e.log());
    assert.strictEqual(kb.switchedTo, null);
  });

  await test("receiver: device coming back is picked up from the notification", async () => {
    const kb = new FakeDev("Signature Slim K950", 1), ms = new FakeDev("Signature Plus M750 L", 1);
    kb.online = false; ms.online = false;                    // both on the laptop at start
    const rx = new FakeHid(0xc548, "USB Receiver", 0xff00, new Map([[1, kb], [2, ms]]));
    const e = startEngine([rx]);
    await wait(1500);
    assert.strictEqual(e.state().devices.length, 0, e.log());
    rx.link(1, true); rx.link(2, true);
    await wait(1500);
    assert.strictEqual(e.state().devices.length, 2, e.log());
  });

  await test("receiver: device back WITHOUT a notification is found by the re-check", async () => {
    const kb = new FakeDev("Signature Slim K950", 1);
    kb.online = false;
    const rx = new FakeHid(0xc548, "USB Receiver", 0xff00, new Map([[1, kb]]));
    const e = startEngine([rx]);
    await wait(1500);
    kb.online = true;                                        // silent return
    await wait(16000);                                       // receiver probe runs every 10 s
    assert.match(e.log(), /connected: Signature Slim K950/, e.log());
  });

  await test("receiver: both drop together (sleep) -> nobody switched", async () => {
    const kb = new FakeDev("Signature Slim K950", 1), ms = new FakeDev("Signature Plus M750 L", 1);
    const rx = new FakeHid(0xc548, "USB Receiver", 0xff00, new Map([[1, kb], [2, ms]]));
    const e = startEngine([rx]);
    await wait(1500);
    rx.link(1, false); rx.link(2, false);
    await wait(1500);
    assert.strictEqual(kb.switchedTo, null); assert.strictEqual(ms.switchedTo, null);
  });

  await test("'send both' command from the settings page", async () => {
    const kb = new FakeDev("Signature Slim K950", 1), ms = new FakeDev("Signature Plus M750 L", 1);
    const rx = new FakeHid(0xc548, "USB Receiver", 0xff00, new Map([[1, kb], [2, ms]]));
    const e = startEngine([rx]);
    await wait(1500);
    e.send({ cmd: "switch", ch: 1 });
    await wait(400);
    assert.strictEqual(kb.switchedTo, 1); assert.strictEqual(ms.switchedTo, 1);
  });

  await test("bluetooth-direct device flags the warning", async () => {
    const bt = new FakeHid(0xb386, "Logi_K950", 0xff43, new Map([[0xff, new FakeDev("Signature Slim K950")]]));
    const e = startEngine([bt]);
    await wait(1000);
    assert.strictEqual(e.state().btDirect, true, e.log());
  });

  console.log(failed ? `${failed} test(s) failed` : "all tests passed");
  process.exit(failed ? 1 : 0);
})();

