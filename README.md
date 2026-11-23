# logi-sync kit

Keeps a Logitech keyboard and mouse on the same Easy-Switch channel. Press
Easy-Switch on **either** device and the other one follows about a second later.
It works in both directions, with no network between the computers and no
Logitech software needed.

Tested with a **Signature Slim K950** keyboard and a **Signature Plus M750 L** mouse.
It should work with any Logitech device that has Easy-Switch.

| Computer | Connects to the devices by | Uses |
|---|---|---|
| **Laptop** (your own PC) | Bluetooth, built in | `laptop/` — a PowerShell script that runs in the background |
| **Work desktop** (locked down) | Logitech USB receiver | `desktop-extension/` — an Edge/Chrome extension (or `desktop-fallback/`, a single page, if extensions are blocked) |

Each computer needs its own half. Neither half needs admin rights.

---

## 1. Laptop setup (one time)

1. Copy the `laptop` folder to the laptop, anywhere you like.
2. Double-click **`setup-laptop.cmd`**.

   That's it. It will:
   - copy the script to `%LOCALAPPDATA%\logi-sync\`
   - run a self-test
   - set it to start at every logon (a small file in your Startup folder)
   - start it now, hidden in the background
   - show which devices it sees and on which channel

   You should see both devices listed and a green
   *"logi-sync is installed"* line.

If you'd rather use a terminal:

```powershell
powershell -ExecutionPolicy Bypass -File laptop\logi-sync.ps1 install
```

**Everyday commands** (from `%LOCALAPPDATA%\logi-sync\`):

```powershell
powershell -ExecutionPolicy Bypass -File logi-sync.ps1 status      # running? which devices, which channel
powershell -ExecutionPolicy Bypass -File logi-sync.ps1 stop
powershell -ExecutionPolicy Bypass -File logi-sync.ps1 start
powershell -ExecutionPolicy Bypass -File logi-sync.ps1 switch 2    # send both devices to channel 2 now
powershell -ExecutionPolicy Bypass -File logi-sync.ps1 uninstall   # remove everything
```

Log: `%LOCALAPPDATA%\logi-sync\logi-sync.log`

> If `install` says PowerShell is in *ConstrainedLanguage* mode, that computer
> is locked down. Use the extension there instead (section 2).

---

## 2. Work desktop setup (one time)

1. Copy the `desktop-extension` folder to the desktop, e.g. `Documents\logi-sync\desktop-extension`.
   **Leave it there.** The browser loads the extension from this folder every time.
2. Open Edge and go to `edge://extensions` (Chrome: `chrome://extensions`).
3. Turn on **Developer mode** (bottom-left in Edge, top-right in Chrome).
4. Click **Load unpacked** and pick the `desktop-extension` folder.
5. The **logi-sync settings page** opens. Click **Add a device…**, pick your
   **Logitech USB receiver** (it may show as "USB Receiver" or "Logi Bolt Receiver"),
   and click **Connect**.
6. With the keyboard and mouse switched to the desktop, both should appear as
   **"here · channel 2 of 3"** within a few seconds.

From now on it runs by itself whenever Edge is open. You can close the settings
page. Reopen it any time from the **logi-sync** icon in the toolbar (it may be
under the puzzle-piece menu).

**Keep Edge running in the background** so it also works with no Edge window open:
`edge://settings/system`, then turn on *"Continue running background extensions and apps when Microsoft Edge is closed"*.

> **Developer mode greyed out?** Your company blocks unpacked extensions. Use
> the fallback instead: open `desktop-fallback/logi-sync.html` in Edge, click
> **Add a device…**, pick the receiver, and keep that tab open (pin it).

---

## 3. Try it

1. Both devices on the laptop. Press **Easy-Switch 2** on the keyboard. About a
   second later the mouse moves to the desktop by itself.
2. On the desktop, press the mouse's **Easy-Switch** button until it's on channel 1.
   The keyboard follows back to the laptop.

Any device can lead in either direction.

---

## How it works

- Software can't intercept the Easy-Switch keys on these devices, and a switch gives
  no warning. The device just disconnects. So each computer watches for that:
  **if one device leaves and stays gone for 1 second while the other is still
  here, the other is sent to the same place** with Logitech's HID++ *ChangeHost*
  command.
- **"The same place" is worked out by computer name, not channel number.** Each
  device remembers the name of the computer on each of its channels, and
  logi-sync reads those names:
  - **The mouse leads:** its button cycles to the next channel, so we know exactly
    which computer it went to. The keyboard goes to the channel with that name.
  - **The keyboard leads:** the mouse goes to the other computer both devices are
    paired with. If there are several (an iPad on channel 3, say), it picks the one
    used last time. With no history yet, it picks the lowest other channel.
  - Any channel layout works, including the keyboard and mouse numbering the same
    computer differently.
  - To pin a fixed channel instead, use the extension's **Follow to** setting or the
    script's `-Target 3`.
  - `logi-sync.ps1 status` shows each device's channels and computer names.
- Nothing happens if **both** devices drop at once (sleep, Bluetooth off), or if
  the device comes back within the second.
- Both halves re-check the real device state every few seconds, so a missed event
  corrects itself. If a disconnect is only noticed late, nothing is moved.

## Good to know

- **Turning a device off** looks the same as switching it away, so the other one
  follows. On the laptop, run `stop` first if you do this on purpose.
- With **three or more** computers, a **keyboard**-led switch is a best guess:
  the most recently used other computer. Mouse-led switches are exact.
- The **extension needs a USB receiver** on that computer. With direct Bluetooth,
  the browser forgets the device each time it switches away, because those devices
  report no serial number. The extension shows a warning if that's the case. Use
  the laptop script on such computers.
- **Why not one app for both?** The laptop has Smart App Control, which blocks
  unsigned `.exe` files. The desktop's PowerShell is locked to ConstrainedLanguage.
  A script plus an extension is what both machines allow.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Laptop: `status` shows *not running* | `logi-sync.ps1 start`, then check the log |
| Extension page says *"background engine isn't responding"* | Click **Restart it**, or toggle the extension off/on in `edge://extensions` |
| Extension: device shows *"not connected here"* while it is | Wait 10 s (automatic re-check). If it stays, click **Copy log** and look at the last lines |
| *"Add a device"* shows nothing | Click **Diagnose…**, pick the dongle, and check the `diagnose:` line in the log |
| Follows when you didn't want it | Untick **enabled** (extension) or run `stop` (laptop) |

## Tests

```powershell
node tests\ext-engine.test.js                                         # extension engine vs. simulated receiver
powershell -ExecutionPolicy Bypass -File laptop\logi-sync.ps1 selftest  # follow rule
```
