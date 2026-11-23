// Settings page: grants device access (needs a click), edits settings and
// shows the engine's state. The engine itself runs in offscreen.html.
"use strict";
const LOGI = 0x046d, UP_BLE = 0xff43, UP_RECEIVER = 0xff00;
const $ = (id) => document.getElementById(id);
const hex = (n, w = 4) => n.toString(16).padStart(w, "0");
const store = {
  get(k, d) { try { const v = localStorage.getItem("logi-sync:" + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("logi-sync:" + k, JSON.stringify(v)); } catch {} },
};
const bus = new BroadcastChannel("logi-sync");

function appendLog(msg) {
  const lines = store.get("log", []);
  lines.unshift(`${new Date().toLocaleString()} ${msg}`);
  lines.length = Math.min(lines.length, 300);
  store.set("log", lines);
  render();
}

function render() {
  const state = store.get("state", null);
  const known = store.get("known", {});
  const here = new Map(((state && state.devices) || []).map((d) => [d.key, d]));
  const ul = $("devs"); ul.innerHTML = "";
  for (const [key, name] of Object.entries(known)) {
    const d = here.get(key);
    const li = document.createElement("li");
    const a = document.createElement("span"), b = document.createElement("span");
    a.textContent = d ? d.name : name;
    b.className = d ? "on" : "off";
    b.textContent = d ? `here · channel ${d.channel} of ${d.hosts}` : "not connected here";
    li.append(a, b); ul.appendChild(li);
  }
  if (state && state.receivers && state.receivers.length) {
    const li = document.createElement("li");
    const a = document.createElement("span"), b = document.createElement("span");
    a.textContent = state.receivers.join(", "); b.className = "on"; b.textContent = "receiver";
    li.append(a, b); ul.appendChild(li);
  }
  $("hint").hidden = Object.keys(known).length >= 2;
  $("btwarn").hidden = !(state && state.btDirect);
  const age = state ? Date.now() - (state.checked || state.at) : Infinity;
  $("stale").hidden = age < 20000;
  $("checked").textContent = state ? `engine checked devices ${Math.round(age / 1000)} s ago` : "waiting for the engine…";
  $("log").textContent = store.get("log", []).join("\n");
}

$("add").onclick = async () => {
  try {
    const picked = await navigator.hid.requestDevice({ filters: [
      { vendorId: LOGI, usagePage: UP_BLE },
      { vendorId: LOGI, usagePage: UP_RECEIVER },
    ] });
    for (const h of picked) appendLog(`access granted: ${h.productName || hex(h.productId)}`);
    bus.postMessage({ cmd: "rescan" });
  } catch (e) { appendLog("add failed: " + e.message); }
};

$("diag").onclick = async () => {
  try {
    const picked = await navigator.hid.requestDevice({ filters: [] });
    for (const h of picked) {
      const cols = h.collections.map((c) => `${hex(c.usagePage)}:${hex(c.usage)}`).join(", ");
      appendLog(`diagnose: "${h.productName}" vid ${hex(h.vendorId)} pid ${hex(h.productId)} collections [${cols}]`);
    }
    if (!picked.length) appendLog("diagnose: nothing picked");
  } catch (e) { appendLog("diagnose failed: " + e.message); }
};

$("restart").onclick = () => chrome.runtime.sendMessage({ cmd: "ensure-engine" });

$("copylog").onclick = async () => {
  try { await navigator.clipboard.writeText(store.get("log", []).join("\n")); $("copylog").textContent = "Copied"; }
  catch { $("copylog").textContent = "Copy failed"; }
  setTimeout(() => ($("copylog").textContent = "Copy log"), 1500);
};

document.querySelectorAll("button[data-ch]").forEach((b) => (b.onclick = () => bus.postMessage({ cmd: "switch", ch: Number(b.dataset.ch) })));

$("target").value = String(store.get("target", 0));
$("delay").value = String(store.get("delay", 1));
$("enabled").checked = store.get("enabled", true) !== false;
$("target").onchange = () => store.set("target", Number($("target").value));
$("delay").onchange = () => store.set("delay", Number($("delay").value));
$("enabled").onchange = () => store.set("enabled", $("enabled").checked);

window.addEventListener("storage", render);   // fires when the engine updates state/log
setInterval(render, 2000);
chrome.runtime.sendMessage({ cmd: "ensure-engine" }).catch(() => {});
render();
