// Service worker: its only job is to keep the hidden engine page alive.
// The engine (offscreen.html + engine.js) holds the HID connections; service
// workers are shut down when idle, offscreen documents are not.
"use strict";

async function ensureEngine() {
  try {
    const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    if (existing.length) return;
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["LOCAL_STORAGE"],
      justification: "Keeps the HID connection to the keyboard and mouse open so they can follow each other's Easy-Switch.",
    });
  } catch (e) {
    // "Only a single offscreen document may be created" = already running.
    if (!/single offscreen/i.test(String(e))) console.error("logi-sync: could not start engine", e);
  }
}

chrome.runtime.onInstalled.addListener(() => { chrome.alarms.create("keepalive", { periodInMinutes: 1 }); ensureEngine(); chrome.runtime.openOptionsPage(); });
chrome.runtime.onStartup.addListener(() => { chrome.alarms.create("keepalive", { periodInMinutes: 1 }); ensureEngine(); });
chrome.alarms.onAlarm.addListener(() => ensureEngine());
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
chrome.runtime.onMessage.addListener((msg) => { if (msg && msg.cmd === "ensure-engine") ensureEngine(); });
ensureEngine();
