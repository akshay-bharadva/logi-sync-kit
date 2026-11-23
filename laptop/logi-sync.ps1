<#
.SYNOPSIS
    logi-sync: keep a Logitech keyboard and mouse on the same Easy-Switch channel.

.DESCRIPTION
    Run this on every computer the devices are paired with. When you press
    Easy-Switch on ONE device (keyboard or mouse), that device leaves this
    computer; logi-sync notices and sends the OTHER device to the same channel.

    Nothing is installed: this single script compiles a small HID helper in
    memory and talks to the devices over Bluetooth with Logitech's HID++
    protocol. No admin rights, no network.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File logi-sync.ps1 install   # one-time setup: copy, autostart, start
    powershell -ExecutionPolicy Bypass -File logi-sync.ps1 uninstall # undo all of it
    powershell -ExecutionPolicy Bypass -File logi-sync.ps1 start     # run hidden in background
    powershell -ExecutionPolicy Bypass -File logi-sync.ps1 status    # devices, channels, running?
    powershell -ExecutionPolicy Bypass -File logi-sync.ps1 switch 2  # send both devices to channel 2 now
    powershell -ExecutionPolicy Bypass -File logi-sync.ps1 autostart on
#>
param(
    [Parameter(Position = 0)]
    [ValidateSet('install', 'uninstall', 'run', 'start', 'stop', 'status', 'switch', 'autostart', 'listen', 'selftest', 'help')]
    [string]$Command = 'help',

    [Parameter(Position = 1)]
    [string]$Arg,

    # Channel (1-3) to send the remaining device to. 0 = automatic: 1 <-> 2.
    [int]$Target = 0,

    # Seconds a device must stay gone before the other one follows.
    [double]$Delay = 1.0
)

$ErrorActionPreference = 'Stop'
$AppDir  = Join-Path $env:LOCALAPPDATA 'logi-sync'
$LogFile = Join-Path $AppDir 'logi-sync.log'
$PidFile = Join-Path $AppDir 'logi-sync.pid'
New-Item -ItemType Directory -Force $AppDir | Out-Null

$source = @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Collections.Concurrent;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace LogiSync
{
    // ------------------------------------------------------------------ HID
    public class HidInfo
    {
        public string Path;
        public ushort Vid, Pid, UsagePage, Usage;
        public int InLen, OutLen;
    }

    public static class Native
    {
        [StructLayout(LayoutKind.Sequential)]
        public struct SP_DEVICE_INTERFACE_DATA { public int cbSize; public Guid InterfaceClassGuid; public int Flags; public IntPtr Reserved; }
        [StructLayout(LayoutKind.Sequential)]
        public struct HIDD_ATTRIBUTES { public int Size; public ushort VendorID; public ushort ProductID; public ushort VersionNumber; }
        [StructLayout(LayoutKind.Sequential)]
        public struct HIDP_CAPS
        {
            public ushort Usage, UsagePage, InputReportByteLength, OutputReportByteLength, FeatureReportByteLength;
            [MarshalAs(UnmanagedType.ByValArray, SizeConst = 17)] public ushort[] Reserved;
            public ushort NumberLinkCollectionNodes, NumberInputButtonCaps, NumberInputValueCaps, NumberInputDataIndices,
                NumberOutputButtonCaps, NumberOutputValueCaps, NumberOutputDataIndices,
                NumberFeatureButtonCaps, NumberFeatureValueCaps, NumberFeatureDataIndices;
        }

        [DllImport("hid.dll")] public static extern void HidD_GetHidGuid(out Guid g);
        [DllImport("hid.dll")] public static extern bool HidD_GetAttributes(SafeFileHandle h, ref HIDD_ATTRIBUTES a);
        [DllImport("hid.dll")] public static extern bool HidD_GetPreparsedData(SafeFileHandle h, out IntPtr p);
        [DllImport("hid.dll")] public static extern bool HidD_FreePreparsedData(IntPtr p);
        [DllImport("hid.dll")] public static extern int HidP_GetCaps(IntPtr p, ref HIDP_CAPS c);

        [DllImport("setupapi.dll", SetLastError = true)]
        public static extern IntPtr SetupDiGetClassDevs(ref Guid g, IntPtr e, IntPtr w, int flags);
        [DllImport("setupapi.dll", SetLastError = true)]
        public static extern bool SetupDiEnumDeviceInterfaces(IntPtr set, IntPtr info, ref Guid g, int idx, ref SP_DEVICE_INTERFACE_DATA d);
        [DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool SetupDiGetDeviceInterfaceDetail(IntPtr set, ref SP_DEVICE_INTERFACE_DATA d, IntPtr detail, int size, out int req, IntPtr info);
        [DllImport("setupapi.dll")] public static extern bool SetupDiDestroyDeviceInfoList(IntPtr set);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr sec, uint disp, uint flags, IntPtr tmpl);

        public const int DIGCF_PRESENT = 2, DIGCF_DEVICEINTERFACE = 0x10;
        public const uint GENERIC_READ = 0x80000000, GENERIC_WRITE = 0x40000000;
        public const uint FILE_SHARE_RW = 3, OPEN_EXISTING = 3, FILE_FLAG_OVERLAPPED = 0x40000000;
    }

    public static class Hid
    {
        public const ushort LogitechVid = 0x046D;

        public static List<HidInfo> Enumerate(ushort vid)
        {
            var result = new List<HidInfo>();
            Guid g; Native.HidD_GetHidGuid(out g);
            IntPtr set = Native.SetupDiGetClassDevs(ref g, IntPtr.Zero, IntPtr.Zero, Native.DIGCF_PRESENT | Native.DIGCF_DEVICEINTERFACE);
            try
            {
                var d = new Native.SP_DEVICE_INTERFACE_DATA(); d.cbSize = Marshal.SizeOf(d);
                for (int i = 0; Native.SetupDiEnumDeviceInterfaces(set, IntPtr.Zero, ref g, i, ref d); i++)
                {
                    int req;
                    Native.SetupDiGetDeviceInterfaceDetail(set, ref d, IntPtr.Zero, 0, out req, IntPtr.Zero);
                    IntPtr buf = Marshal.AllocHGlobal(req);
                    try
                    {
                        Marshal.WriteInt32(buf, IntPtr.Size == 8 ? 8 : 6); // cbSize of SP_DEVICE_INTERFACE_DETAIL_DATA_W
                        if (!Native.SetupDiGetDeviceInterfaceDetail(set, ref d, buf, req, out req, IntPtr.Zero)) continue;
                        var info = Query(Marshal.PtrToStringUni(buf + 4), vid);
                        if (info != null) result.Add(info);
                    }
                    finally { Marshal.FreeHGlobal(buf); }
                }
            }
            finally { Native.SetupDiDestroyDeviceInfoList(set); }
            return result;
        }

        static HidInfo Query(string path, ushort vid)
        {
            // Zero access rights: allowed even on collections Windows holds exclusively.
            using (var h = Native.CreateFile(path, 0, Native.FILE_SHARE_RW, IntPtr.Zero, Native.OPEN_EXISTING, 0, IntPtr.Zero))
            {
                if (h.IsInvalid) return null;
                var a = new Native.HIDD_ATTRIBUTES(); a.Size = Marshal.SizeOf(a);
                if (!Native.HidD_GetAttributes(h, ref a) || a.VendorID != vid) return null;
                var info = new HidInfo { Path = path, Vid = a.VendorID, Pid = a.ProductID };
                IntPtr p;
                if (Native.HidD_GetPreparsedData(h, out p))
                {
                    var c = new Native.HIDP_CAPS();
                    Native.HidP_GetCaps(p, ref c);
                    Native.HidD_FreePreparsedData(p);
                    info.UsagePage = c.UsagePage; info.Usage = c.Usage;
                    info.InLen = c.InputReportByteLength; info.OutLen = c.OutputReportByteLength;
                }
                return info;
            }
        }

        /// HID++ "long report" collections of Bluetooth-direct Logitech devices.
        public static List<HidInfo> HidppEndpoints()
        {
            var r = new List<HidInfo>();
            foreach (var i in Enumerate(LogitechVid))
                if (i.UsagePage == 0xFF43 && i.Usage == 0x0202) r.Add(i);
            return r;
        }

        public static FileStream Open(string path)
        {
            var h = Native.CreateFile(path, Native.GENERIC_READ | Native.GENERIC_WRITE, Native.FILE_SHARE_RW,
                IntPtr.Zero, Native.OPEN_EXISTING, Native.FILE_FLAG_OVERLAPPED, IntPtr.Zero);
            if (h.IsInvalid) throw new IOException("open failed, win32 error " + Marshal.GetLastWin32Error());
            return new FileStream(h, FileAccess.ReadWrite, 1, true); // bufferSize 1 = unbuffered: every report goes out immediately
        }
    }

    // --------------------------------------------------------------- HID++
    public class HidppException : Exception { public HidppException(string m) : base(m) { } }

    /// One Bluetooth-direct HID++ 2.0 device. A background thread reads every
    /// report; requests wait for their matching reply. When the device goes
    /// away the read fails and Lost is raised once.
    public class HidppDevice : IDisposable
    {
        const byte LongReport = 0x11, DevIndex = 0xFF, SwId = 0x0D;
        public const ushort FeatRoot = 0x0000, FeatDeviceName = 0x0005, FeatChangeHost = 0x1814, FeatHostsInfo = 0x1815;
        /// Name of the computer paired on each channel ("" = empty channel). Empty array if unsupported.
        public string[] HostNames = new string[0];
        /// Channels marked as running logi-sync (Easy-Switch cookie == Marker).
        public bool[] Participants = new bool[0];
        /// Cookie value meaning "logi-sync runs on this channel". Stored on the device per channel.
        public const byte Marker = 0x4C;   // 'L'

        public readonly string Path;
        public readonly ushort Pid;
        public string Name = "";
        public int HostCount, CurrentHost = -1;   // 0-based
        public volatile bool Alive = true;
        public readonly DateTime ConnectedAt = DateTime.UtcNow;
        public bool Marked;
        static int swSeq;
        /// Software ids 2..9 (Logitech's own software uses others, e.g. 0xC).
        static byte NextSwId() { return (byte)(2 + (Interlocked.Increment(ref swSeq) & 0x7)); }
        public event Action<HidppDevice> Lost;

        readonly FileStream fs;
        readonly object replyGate = new object();
        byte[] pendingKey;      // [featureIndex, fn|sw] of the request in flight
        byte[] reply;
        byte changeHostIndex;

        public HidppDevice(HidInfo info)
        {
            Path = info.Path; Pid = info.Pid;
            fs = Hid.Open(info.Path);
            var t = new Thread(ReadLoop); t.IsBackground = true; t.Start();
        }

        void ReadLoop()
        {
            var buf = new byte[20];
            try
            {
                while (true)
                {
                    int n = fs.Read(buf, 0, buf.Length);
                    if (n <= 0) break;
                    if (n < 6 || buf[0] != LongReport || buf[1] != DevIndex) continue;
                    lock (replyGate)
                    {
                        if (pendingKey == null) continue;
                        bool ok = buf[2] == pendingKey[0] && buf[3] == pendingKey[1];
                        bool err = buf[2] == 0xFF && buf[3] == pendingKey[0] && buf[4] == pendingKey[1];
                        if (ok || err)
                        {
                            reply = (byte[])buf.Clone();
                            pendingKey = null;
                            Monitor.PulseAll(replyGate);
                        }
                    }
                }
            }
            catch (Exception) { }
            Alive = false;
            lock (replyGate) Monitor.PulseAll(replyGate);
            var h = Lost; if (h != null) h(this);
        }

        public byte[] Request(byte featureIndex, byte function, byte[] args, int timeoutMs)
        {
            var frame = new byte[20];
            frame[0] = LongReport; frame[1] = DevIndex; frame[2] = featureIndex;
            // A different software id per request: a late reply to an earlier (timed-out)
            // request then can't be mistaken for this one's.
            frame[3] = (byte)((function << 4) | NextSwId());
            if (args != null) Array.Copy(args, 0, frame, 4, Math.Min(args.Length, 16));
            lock (replyGate)
            {
                pendingKey = new byte[] { frame[2], frame[3] };
                reply = null;
                fs.Write(frame, 0, frame.Length);
                var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
                while (reply == null && Alive)
                {
                    var left = deadline - DateTime.UtcNow;
                    if (left <= TimeSpan.Zero) { pendingKey = null; throw new HidppException("timeout"); }
                    Monitor.Wait(replyGate, left);
                }
                if (reply == null) throw new HidppException("device disconnected");
                if (reply[2] == 0xFF) throw new HidppException("device error 0x" + reply[5].ToString("x2"));
                var p = new byte[16]; Array.Copy(reply, 4, p, 0, 16);
                return p;
            }
        }

        /// Fire-and-forget: the device drops the link while switching, so no reply comes.
        public void Post(byte featureIndex, byte function, byte[] args)
        {
            var frame = new byte[20];
            frame[0] = LongReport; frame[1] = DevIndex; frame[2] = featureIndex;
            frame[3] = (byte)((function << 4) | SwId);
            if (args != null) Array.Copy(args, 0, frame, 4, Math.Min(args.Length, 16));
            fs.Write(frame, 0, frame.Length);
        }

        public byte FeatureIndex(ushort id)
        {
            var r = Request(0, 0, new byte[] { (byte)(id >> 8), (byte)id }, 1500);
            if (r[0] == 0) throw new HidppException("feature 0x" + id.ToString("x4") + " not supported");
            return r[0];
        }

        /// Query name and Easy-Switch state. Throws if this isn't a multi-host device.
        public void Initialize()
        {
            changeHostIndex = FeatureIndex(FeatChangeHost);
            RefreshHost();
            try
            {
                byte ni = FeatureIndex(FeatDeviceName);
                int len = Request(ni, 0, null, 1500)[0];
                var sb = new StringBuilder();
                while (sb.Length < len)
                {
                    var chunk = Request(ni, 1, new byte[] { (byte)sb.Length }, 1500);
                    for (int i = 0; i < 16 && sb.Length < len; i++) sb.Append((char)chunk[i]);
                }
                Name = sb.ToString().TrimEnd('\0');
            }
            catch (HidppException) { Name = "Logitech " + Pid.ToString("x4"); }
            // Right after a reconnect the device is busy (Logitech's own software
            // floods it), so retry, and fall back to the last good read.
            HostNames = new string[0];
            for (int attempt = 0; attempt < 3 && HostNames.Length == 0; attempt++)
            {
                try { HostNames = ReadHostNames(); }
                catch (HidppException e)
                {
                    if (e.Message.Contains("not supported")) break;   // retry only if busy
                    Thread.Sleep(400);
                }
            }
            if (HostNames.Length == 0) HostNames = NameCache.Load(Pid, HostCount);
            else NameCache.Save(Pid, HostNames);
            try { ReadMarks(); } catch (HidppException) { }
        }

        /// CHANGE_HOST fn2 getCookies -> one byte per channel; fn3 setCookie(host, value).
        void ReadMarks()
        {
            var c = Request(changeHostIndex, 2, null, 1500);
            Participants = new bool[HostCount];
            for (int i = 0; i < HostCount && i < 16; i++) Participants[i] = c[i] == Marker;
            Marked = CurrentHost >= 0 && CurrentHost < Participants.Length && Participants[CurrentHost];
        }

        /// Mark this channel as running logi-sync, but only once the device has
        /// stayed connected for `stable` and still reports the same channel.
        /// (While you cycle the mouse button through channels it touches each
        /// computer briefly and may already report the NEXT channel: marking then
        /// put a mark on the iPad's channel.)
        /// Returns true if it wrote the mark.
        public bool TryMarkIfStable(TimeSpan stable)
        {
            if (Marked || !Alive || DateTime.UtcNow - ConnectedAt < stable) return false;
            int before = CurrentHost;
            RefreshHost();
            if (CurrentHost != before) { Marked = true; return false; }   // it's leaving; never mark
            var c = Request(changeHostIndex, 2, null, 1500);
            if (c[CurrentHost] != Marker) Request(changeHostIndex, 3, new byte[] { (byte)CurrentHost, Marker }, 1500);
            ReadMarks();
            Marked = true;
            return true;
        }

        /// HOSTS_INFO (0x1815): fn1 getHostInfo(host) -> [host, status, bus, pages, nameLen, nameMax];
        /// fn3 getHostFriendlyName(host, offset) -> [host, offset, 14 bytes of UTF-8 name].
        string[] ReadHostNames()
        {
            byte fi = FeatureIndex(FeatHostsInfo);
            var names = new string[HostCount];
            for (int h = 0; h < HostCount; h++)
            {
                var info = Request(fi, 1, new byte[] { (byte)h }, 1500);
                if (info[0] != h) throw new HidppException("host info reply for wrong channel");
                int len = info[4];
                var bytes = new List<byte>();
                while (bytes.Count < len)
                {
                    var r = Request(fi, 3, new byte[] { (byte)h, (byte)bytes.Count }, 1500);
                    // A late reply to an earlier request would otherwise be read as this one.
                    if (r[0] != h || r[1] != bytes.Count) throw new HidppException("host name reply out of order");
                    int take = Math.Min(14, len - bytes.Count);
                    for (int i = 0; i < take; i++) bytes.Add(r[2 + i]);
                }
                names[h] = Encoding.UTF8.GetString(bytes.ToArray()).TrimEnd('\0').Trim();
            }
            return names;
        }

        public void RefreshHost()
        {
            var r = Request(changeHostIndex, 0, null, 1500);
            HostCount = r[0]; CurrentHost = r[1];
        }

        /// Switch to Easy-Switch channel (1-based).
        public void SwitchTo(int channel)
        {
            if (channel < 1 || channel > HostCount) throw new ArgumentOutOfRangeException("channel", "device has " + HostCount + " channels");
            Post(changeHostIndex, 1, new byte[] { (byte)(channel - 1) });
        }

        /// Logitech keyboard model names carry a K-number (K950, MX Keys = K-series pid ranges aside).
        public bool IsKeyboard { get { return Regex.IsMatch(Name, @"\bK\d") || Name.IndexOf("Keys", StringComparison.OrdinalIgnoreCase) >= 0; } }

        public void Dispose() { try { fs.Dispose(); } catch { } }
        public override string ToString() { return Name + " (pid " + Pid.ToString("x4") + ")"; }
    }

    /// Last good per-channel computer names per device model, for when reading fails.
    public static class NameCache
    {
        static string File(ushort pid)
        {
            return System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "logi-sync", "names-" + pid.ToString("x4") + ".txt");
        }
        public static void Save(ushort pid, string[] names)
        {
            try { System.IO.File.WriteAllLines(File(pid), names, Encoding.UTF8); } catch { }
        }
        public static string[] Load(ushort pid, int count)
        {
            try
            {
                var n = System.IO.File.ReadAllLines(File(pid), Encoding.UTF8);
                return n.Length == count ? n : new string[0];
            }
            catch { return new string[0]; }
        }
    }

    // -------------------------------------------------------------- policy
    /// The follow rule, kept free of I/O so it can be tested.
    /// A device that leaves and stays gone for `delay` drags every device that
    /// is still here to the target channel. If nothing is left here (sleep,
    /// Bluetooth off, both switched by hand) nothing happens.
    public class FollowPolicy
    {
        readonly TimeSpan delay;
        readonly Dictionary<string, DateTime> lostAt = new Dictionary<string, DateTime>();
        readonly HashSet<string> present = new HashSet<string>();

        public FollowPolicy(TimeSpan delay) { this.delay = delay; }

        public void Found(string id) { present.Add(id); lostAt.Remove(id); }

        public void Lost(string id, DateTime now)
        {
            if (!present.Remove(id)) return;
            if (present.Count > 0) lostAt[id] = now;   // someone left behind: candidate switch
        }

        /// Returns the devices to send away now (empty if none).
        public List<string> Tick(DateTime now)
        {
            var due = new List<string>();
            foreach (var kv in lostAt) if (now - kv.Value >= delay) due.Add(kv.Key);
            if (due.Count == 0) return new List<string>();
            foreach (var id in due) lostAt.Remove(id);
            lostAt.Clear();                            // one decision per departure burst
            return new List<string>(present);
        }

        public static int AutoTarget(int thisChannel) { return thisChannel == 1 ? 2 : 1; }

        static bool Same(string a, string b)
        {
            return !string.IsNullOrEmpty(a) && !string.IsNullOrEmpty(b) &&
                string.Equals(a.Trim(), b.Trim(), StringComparison.OrdinalIgnoreCase);
        }

        static string At(string[] a, int i) { return (a != null && i >= 0 && i < a.Length) ? a[i] : null; }

        static bool Flag(bool[] a, int i) { return a != null && i >= 0 && i < a.Length && a[i]; }
        static int Count(bool[] a, int except) { int n = 0; if (a != null) for (int i = 0; i < a.Length; i++) if (i != except && a[i]) n++; return n; }
        static string Label(string[] names, int i) { var n = At(names, i); return string.IsNullOrEmpty(n) ? "channel " + (i + 1) : n; }

        /// Decide which channel (1-based, in the STAYING device's numbering) to send
        /// the staying device to.
        ///   stay*: the device still here.  gone*: the device that just left.
        ///   *Names: computer name per channel (may be empty).
        ///   *Parts: channels marked as running logi-sync (Easy-Switch cookie).
        ///   learned: computer chosen last time when the choice was certain (may be null).
        /// Only channels running logi-sync are targets once any are known: a device
        /// sent anywhere else (an iPad) would be stranded, because nothing there sends
        /// the other one back. `certain` is true when the destination is known, not guessed.
        public static int ResolveTarget(int stayCurrent, string[] stayNames, bool[] stayParts,
            int goneCurrent, string[] goneNames, bool[] goneParts, int goneHostCount, bool goneIsKeyboard,
            string learned, out string dest, out bool certain, out string why)
        {
            dest = null; certain = false;
            int stayCount = Math.Max(stayNames != null ? stayNames.Length : 0, stayParts != null ? stayParts.Length : 0);
            bool namesBoth = !string.IsNullOrEmpty(At(stayNames, stayCurrent)) && goneNames != null && goneNames.Length > 0;

            // The same computer may sit on different channel numbers on the two devices.
            Func<int, int> toStay = gc =>
            {
                if (namesBoth)
                {
                    string n = At(goneNames, gc);
                    for (int i = 0; i < stayNames.Length; i++) if (i != stayCurrent && Same(stayNames[i], n)) return i;
                    return -1;
                }
                return gc != stayCurrent && (stayCount == 0 || gc < stayCount) ? gc : -1;
            };

            // 1. Mouse-led: its button cycles channels. Walk the cycle to the first channel
            //    running logi-sync (presses through an iPad keep going). With no marks known
            //    yet, assume the very next channel.
            if (!goneIsKeyboard && goneHostCount > 1 && goneCurrent >= 0)
            {
                bool marksKnown = Count(goneParts, goneCurrent) > 0;
                for (int step = 1; step < goneHostCount; step++)
                {
                    int gc = (goneCurrent + step) % goneHostCount;
                    if (marksKnown && !Flag(goneParts, gc)) continue;
                    int sc = toStay(gc);
                    if (sc < 0) break;
                    // Both devices must agree the channel runs logi-sync.
                    if (marksKnown && Count(stayParts, stayCurrent) > 0 && !Flag(stayParts, sc)) continue;
                    certain = true; dest = At(stayNames, sc);
                    why = step == 1 ? "mouse moved to the next channel: " + Label(stayNames, sc)
                                    : "mouse button passes " + (step - 1) + " channel(s) not running logi-sync; next one running it: " + Label(stayNames, sc);
                    return sc + 1;
                }
            }

            // 2. Candidates: channels running logi-sync if any are known; otherwise
            //    other paired computers (both devices know them if names allow).
            var cands = new List<int>();
            string basis = "";
            // The gone device's mark for the same computer (matched by name when possible).
            Func<int, bool> goneMarked = sc =>
            {
                if (namesBoth)
                {
                    int gi = Array.FindIndex(goneNames, n => Same(n, At(stayNames, sc)));
                    return gi >= 0 && Flag(goneParts, gi);
                }
                return Flag(goneParts, sc);
            };
            bool goneMarksKnown = Count(goneParts, goneCurrent) > 0;
            if (Count(stayParts, stayCurrent) > 0)
            {
                // Both devices must carry the mark: one stray mark (written while a
                // device was passing through) can't make a tablet a target.
                for (int i = 0; i < stayParts.Length; i++)
                    if (i != stayCurrent && stayParts[i] && (!goneMarksKnown || goneMarked(i))) cands.Add(i);
                basis = "running logi-sync";
            }
            if (cands.Count == 0)
            {
                string here = At(stayNames, stayCurrent);
                if (!string.IsNullOrEmpty(here))
                {
                    for (int i = 0; i < stayNames.Length; i++)
                        if (i != stayCurrent && !string.IsNullOrEmpty(stayNames[i]) && !Same(stayNames[i], here)) cands.Add(i);
                    if (goneNames != null && goneNames.Length > 0)
                    {
                        var both = cands.FindAll(i => Array.Exists(goneNames, n => Same(n, stayNames[i])));
                        if (both.Count > 0) cands = both;
                    }
                }
                basis = "paired (no logi-sync marks seen yet)";
            }
            if (cands.Count == 0)
            {
                why = "nothing else known: other of 1/2";
                return AutoTarget(stayCurrent + 1);
            }
            int pick = cands[0];
            if (cands.Count == 1)
            {
                certain = basis == "running logi-sync";
                why = "the only other computer " + basis + ": " + Label(stayNames, pick);
            }
            else
            {
                int l = cands.FindIndex(i => Same(stayNames[i], learned));
                if (l >= 0) { pick = cands[l]; why = "last computer you went to (" + basis + "): " + Label(stayNames, pick); }
                else why = "lowest other channel " + basis + ": " + Label(stayNames, pick);
            }
            dest = At(stayNames, pick);
            return pick + 1;
        }
    }

    // -------------------------------------------------------------- engine
    public class Engine
    {
        readonly Action<string> sink;                      // only called on the Run() thread
        readonly ConcurrentQueue<string> pendingLog = new ConcurrentQueue<string>();
        readonly int target;
        readonly FollowPolicy policy;
        readonly Dictionary<string, HidppDevice> devices = new Dictionary<string, HidppDevice>();
        readonly HashSet<string> ignored = new HashSet<string>();   // HID++ but not multi-host
        readonly object gate = new object();
        HidppDevice lastGone;                                        // the device that most recently left
        static readonly string LearnedFile = System.IO.Path.Combine(
            // v2: the v1 file could hold a wrong guess (it learned from guesses).
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "logi-sync", "last-computer-v2.txt");

        static string LoadLearned() { try { return File.ReadAllText(LearnedFile).Trim(); } catch { return null; } }
        static void SaveLearned(string name) { try { if (!string.IsNullOrEmpty(name)) File.WriteAllText(LearnedFile, name); } catch { } }
        public volatile bool Stop;

        public Engine(int target, double delaySeconds, Action<string> log)
        {
            this.target = target; this.sink = log;
            policy = new FollowPolicy(TimeSpan.FromSeconds(delaySeconds));
        }

        void log(string m) { pendingLog.Enqueue(m); }

        void FlushLog() { string m; while (pendingLog.TryDequeue(out m)) sink(m); }

        public void Run()
        {
            log("logi-sync running (target " + (target == 0 ? "auto 1<->2" : target.ToString()) + ")");
            while (!Stop)
            {
                try { Scan(); } catch (Exception e) { log("scan error: " + e.Message); }
                List<string> toSend;
                lock (gate) toSend = policy.Tick(DateTime.UtcNow);
                foreach (var path in toSend) Follow(path);
                List<HidppDevice> settled;
                lock (gate) settled = new List<HidppDevice>(devices.Values);
                foreach (var d in settled)
                {
                    if (d.Marked) continue;
                    try { if (d.TryMarkIfStable(TimeSpan.FromSeconds(5))) log("marked channel " + (d.CurrentHost + 1) + " as running logi-sync on " + d); }
                    catch (Exception) { }
                }
                FlushLog();
                Thread.Sleep(150);
            }
            lock (gate) foreach (var d in devices.Values) d.Dispose();
            FlushLog();
        }

        void Scan()
        {
            var endpoints = Hid.HidppEndpoints();
            var seen = new HashSet<string>();
            foreach (var ep in endpoints)
            {
                seen.Add(ep.Path);
                lock (gate) if (devices.ContainsKey(ep.Path) || ignored.Contains(ep.Path)) continue;
                HidppDevice dev = null;
                try
                {
                    dev = new HidppDevice(ep);
                    dev.Initialize();
                }
                catch (Exception e)
                {
                    if (dev != null) dev.Dispose();
                    // Newly connected devices are often busy for a moment; retry next scan
                    // unless the device plainly lacks Easy-Switch.
                    if (e.Message.Contains("not supported")) lock (gate) ignored.Add(ep.Path);
                    continue;
                }
                dev.Lost += OnLost;
                lock (gate) { devices[ep.Path] = dev; policy.Found(ep.Path); }
                log("connected: " + dev + ", channel " + (dev.CurrentHost + 1) + "/" + dev.HostCount);
            }
            // Devices that vanished from enumeration without a read error.
            List<HidppDevice> gone = new List<HidppDevice>();
            lock (gate) foreach (var kv in devices) if (!seen.Contains(kv.Key)) gone.Add(kv.Value);
            foreach (var d in gone) OnLost(d);
            lock (gate) ignored.IntersectWith(seen);
        }

        void OnLost(HidppDevice dev)
        {
            lock (gate)
            {
                HidppDevice cur;
                if (!devices.TryGetValue(dev.Path, out cur) || cur != dev) return;
                devices.Remove(dev.Path);
                policy.Lost(dev.Path, DateTime.UtcNow);
                lastGone = dev;   // keep its channel table: it tells us where it may have gone
            }
            dev.Dispose();
            log("disconnected: " + dev);
        }

        void Follow(string path)
        {
            HidppDevice dev;
            lock (gate) if (!devices.TryGetValue(path, out dev)) return;
            int channel = target;
            string why = "fixed target";
            if (channel == 0)
            {
                HidppDevice gone;
                lock (gate) gone = lastGone;
                string dest; bool certain;
                channel = FollowPolicy.ResolveTarget(dev.CurrentHost, dev.HostNames, dev.Participants,
                    gone != null ? gone.CurrentHost : -1, gone != null ? gone.HostNames : null,
                    gone != null ? gone.Participants : null,
                    gone != null ? gone.HostCount : 0, gone != null && gone.IsKeyboard,
                    LoadLearned(), out dest, out certain, out why);
                if (certain) SaveLearned(dest);   // never learn from a guess
            }
            try
            {
                log("following: sending " + dev + " to channel " + channel + " (" + why + ")");
                dev.SwitchTo(channel);
            }
            catch (Exception e) { log("switch failed for " + dev + ": " + e.Message); }
        }

        /// One-shot: send every connected device to `channel`.
        public static int SwitchAll(int channel, Action<string> log)
        {
            int n = 0;
            var devs = new List<HidppDevice>();
            foreach (var ep in Hid.HidppEndpoints())
            {
                try { var d = new HidppDevice(ep); d.Initialize(); devs.Add(d); }
                catch (Exception) { }
            }
            // Keyboard last, so you still have it if the mouse can't switch.
            devs.Sort((a, b) => (a.IsKeyboard ? 1 : 0) - (b.IsKeyboard ? 1 : 0));
            foreach (var d in devs)
            {
                try { d.SwitchTo(channel); log("sent " + d + " to channel " + channel); n++; }
                catch (Exception e) { log("switch failed for " + d + ": " + e.Message); }
                Thread.Sleep(50);
                d.Dispose();
            }
            return n;
        }

        public static List<string> Status()
        {
            var lines = new List<string>();
            foreach (var ep in Hid.HidppEndpoints())
            {
                try
                {
                    using (var d = new HidppDevice(ep))
                    {
                        d.Initialize();
                        lines.Add(d + ": channel " + (d.CurrentHost + 1) + " of " + d.HostCount);
                        for (int h = 0; h < d.HostNames.Length; h++)
                            lines.Add("    " + (h + 1) + ": " + (d.HostNames[h].Length > 0 ? d.HostNames[h] : "(empty)") +
                                (h < d.Participants.Length && d.Participants[h] ? "  [runs logi-sync]" : "") +
                                (h == d.CurrentHost ? "  <- this computer" : ""));
                    }
                }
                catch (Exception e) { lines.Add("pid " + ep.Pid.ToString("x4") + ": " + e.Message); }
            }
            return lines;
        }
    }

    // ----------------------------------------------------------- diagnostic
    /// Log every report from every openable Logitech collection plus
    /// connect/disconnect transitions.
    public static class Listener
    {
        public static void Run(int seconds, TextWriter log)
        {
            var t0 = DateTime.Now;
            object gate = new object();
            var open = new HashSet<string>();
            var seen = new HashSet<string>();
            Action<string> say = s => { lock (gate) { log.WriteLine((DateTime.Now - t0).TotalSeconds.ToString("000.000") + " " + s); log.Flush(); } };
            while ((DateTime.Now - t0).TotalSeconds < seconds)
            {
                var list = Hid.Enumerate(Hid.LogitechVid);
                var now = new HashSet<string>();
                foreach (var i in list) now.Add(i.Pid.ToString("x4"));
                foreach (var n in now) if (!seen.Contains(n)) say("CONNECT pid " + n);
                foreach (var n in seen) if (!now.Contains(n)) say("DISCONNECT pid " + n);
                seen = now;
                foreach (var info in list)
                {
                    lock (gate) if (open.Contains(info.Path)) continue;
                    FileStream fs;
                    try { fs = Hid.Open(info.Path); } catch { continue; }
                    lock (gate) open.Add(info.Path);
                    var label = string.Format("{0:x4}/{1:x4}:{2:x4}", info.Pid, info.UsagePage, info.Usage);
                    var path = info.Path;
                    int len = Math.Max(info.InLen, 8);
                    say("listening " + label);
                    var th = new Thread(() =>
                    {
                        var buf = new byte[len];
                        try
                        {
                            int n;
                            while ((n = fs.Read(buf, 0, buf.Length)) > 0)
                                say(label + ": " + BitConverter.ToString(buf, 0, n).Replace("-", " ").ToLower());
                        }
                        catch (Exception e) { say(label + ": closed (" + e.Message.Trim() + ")"); }
                        lock (gate) open.Remove(path);
                    });
                    th.IsBackground = true; th.Start();
                }
                Thread.Sleep(200);
            }
        }
    }
}
'@

function Write-Log([string]$msg) {
    $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Write-Host $line
    try { Add-Content -Path $LogFile -Value $line } catch {}
}

function Get-RunningPid {
    if (-not (Test-Path $PidFile)) { return $null }
    $id = [int](Get-Content $PidFile -ErrorAction SilentlyContinue)
    $p = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -match 'powershell') { return $id }
    return $null
}

function Start-Background {
    if (Get-RunningPid) { Write-Host "logi-sync is already running (pid $(Get-RunningPid))."; return }
    $argList = @('-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", 'run', '-Delay', $Delay)
    if ($Target) { $argList += @('-Target', $Target) }
    $p = Start-Process powershell.exe -ArgumentList $argList -WindowStyle Hidden -PassThru
    Write-Host "logi-sync started in background (pid $($p.Id)). Log: $LogFile"
}

function Invoke-Self([string[]]$CmdArgs, [string]$Script = $PSCommandPath) {
    # Send the child's output to the screen, not down the pipeline: otherwise the
    # function "returns" every printed line plus the exit code, and `-ne 0` on that
    # array is always truthy (install wrongly reported "Self-test failed").
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Script @CmdArgs | Out-Host
    return [int]$LASTEXITCODE
}

# Commands that don't need the HID helper.
switch ($Command) {
    'help' { Get-Help $PSCommandPath -Detailed; return }
    'install' {
        if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
            Write-Host "PowerShell on this computer is in $($ExecutionContext.SessionState.LanguageMode) mode, so logi-sync.ps1 can't run here." -ForegroundColor Yellow
            Write-Host 'Use the browser extension instead (see README).'
            exit 1
        }
        $installed = Join-Path $AppDir 'logi-sync.ps1'
        Write-Host '1/5  Stopping any running copy...'
        if (Test-Path $installed) { [void](Invoke-Self @('stop') $installed) }
        Write-Host "2/5  Copying script to $installed"
        if ((Resolve-Path $PSCommandPath).Path -ne $installed) { Copy-Item -Force $PSCommandPath $installed }
        Unblock-File $installed -ErrorAction SilentlyContinue   # drop the "downloaded from the internet" mark
        Write-Host '3/5  Self-test...'
        if ((Invoke-Self @('selftest') $installed) -ne 0) { Write-Host 'Self-test failed; not installing.' -ForegroundColor Red; exit 1 }
        $extra = @('-Delay', $Delay); if ($Target) { $extra += @('-Target', $Target) }
        Write-Host '4/5  Turning on start at logon...'
        [void](Invoke-Self (@('autostart', 'on') + $extra) $installed)
        Write-Host '5/5  Starting in the background...'
        [void](Invoke-Self (@('start') + $extra) $installed)
        Start-Sleep -Seconds 4
        [void](Invoke-Self @('status') $installed)
        Write-Host ''
        Write-Host 'logi-sync is installed. Press Easy-Switch on either device and the other will follow.' -ForegroundColor Green
        Write-Host "Log: $LogFile"
        return
    }
    'uninstall' {
        $installed = Join-Path $AppDir 'logi-sync.ps1'
        $self = $installed; if (-not (Test-Path $installed)) { $self = $PSCommandPath }
        [void](Invoke-Self @('stop') $self)
        [void](Invoke-Self @('autostart', 'off') $self)
        Remove-Item $installed -Force -ErrorAction SilentlyContinue
        Write-Host "logi-sync removed. (Log kept at $LogFile)"
        return
    }
    'start' { Start-Background; return }
    'stop' {
        $id = Get-RunningPid
        if ($id) { Stop-Process -Id $id -Force; Remove-Item $PidFile -Force; Write-Host "logi-sync stopped." }
        else { Write-Host 'logi-sync is not running.' }
        return
    }
    'autostart' {
        $startup = [Environment]::GetFolderPath('Startup')
        $cmdFile = Join-Path $startup 'logi-sync.cmd'
        if ($Arg -eq 'off') { Remove-Item $cmdFile -ErrorAction SilentlyContinue; Write-Host 'Autostart removed.'; return }
        $extra = ''; if ($Target) { $extra = " -Target $Target" }
        Set-Content -Path $cmdFile -Encoding ASCII -Value "@start `"`" /min powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`" start -Delay $Delay$extra"
        Write-Host "Autostart on: $cmdFile"
        return
    }
}

Add-Type -TypeDefinition $source -Language CSharp

switch ($Command) {
    'run' {
        $mutex = New-Object System.Threading.Mutex($false, 'Local\logi-sync')
        if (-not $mutex.WaitOne(0)) { Write-Host 'logi-sync is already running.'; return }
        Set-Content -Path $PidFile -Value $PID
        $engine = New-Object LogiSync.Engine($Target, $Delay, [Action[string]] { param($m) Write-Log $m })
        try { $engine.Run() } finally { Remove-Item $PidFile -ErrorAction SilentlyContinue; $mutex.ReleaseMutex() }
    }
    'status' {
        $id = Get-RunningPid
        if ($id) { Write-Host "Background service: running (pid $id)" } else { Write-Host 'Background service: not running' }
        [LogiSync.Engine]::Status() | ForEach-Object { Write-Host "  $_" }
    }
    'switch' {
        $ch = [int]$Arg
        if ($ch -lt 1 -or $ch -gt 3) { throw 'usage: logi-sync.ps1 switch <1|2|3>' }
        [void][LogiSync.Engine]::SwitchAll($ch, [Action[string]] { param($m) Write-Log $m })
    }
    'listen' {
        $secs = 120; if ($Arg) { $secs = [int]$Arg }
        [LogiSync.Listener]::Run($secs, [Console]::Out)
    }
    'selftest' {
        # Unit checks of the follow rule (no devices needed).
        $fail = 0
        function Check($name, $cond) { if ($cond) { Write-Host "ok   $name" } else { Write-Host "FAIL $name"; $script:fail++ } }
        $t = [DateTime]::UtcNow
        $s = [TimeSpan]::FromSeconds(1)

        $p = New-Object LogiSync.FollowPolicy($s); $p.Found('kb'); $p.Found('mouse')
        $p.Lost('kb', $t)
        Check 'nothing before delay' ($p.Tick($t.AddMilliseconds(500)).Count -eq 0)
        $r = $p.Tick($t.AddMilliseconds(1100))
        Check 'mouse follows keyboard' ($r.Count -eq 1 -and $r[0] -eq 'mouse')
        Check 'only once' ($p.Tick($t.AddSeconds(3)).Count -eq 0)

        $p = New-Object LogiSync.FollowPolicy($s); $p.Found('kb'); $p.Found('mouse')
        $p.Lost('mouse', $t)
        $r = $p.Tick($t.AddSeconds(2))
        Check 'keyboard follows mouse' ($r.Count -eq 1 -and $r[0] -eq 'kb')

        $p = New-Object LogiSync.FollowPolicy($s); $p.Found('kb'); $p.Found('mouse')
        $p.Lost('kb', $t); $p.Lost('mouse', $t.AddMilliseconds(300))
        Check 'both gone (sleep / BT off): no action' ($p.Tick($t.AddSeconds(2)).Count -eq 0)

        $p = New-Object LogiSync.FollowPolicy($s); $p.Found('kb'); $p.Found('mouse')
        $p.Lost('kb', $t); $p.Found('kb')
        Check 'blip (device back within delay): no action' ($p.Tick($t.AddSeconds(2)).Count -eq 0)

        $p = New-Object LogiSync.FollowPolicy($s); $p.Found('kb')
        $p.Lost('kb', $t)
        Check 'single device: no action' ($p.Tick($t.AddSeconds(2)).Count -eq 0)

        $p = New-Object LogiSync.FollowPolicy($s); $p.Found('kb'); $p.Found('mouse')
        $p.Lost('kb', $t); [void]$p.Tick($t.AddSeconds(2)); $p.Lost('mouse', $t.AddSeconds(2.1))
        Check 'followed device leaving does not bounce' ($p.Tick($t.AddSeconds(5)).Count -eq 0)

        Check 'auto target 1 -> 2' ([LogiSync.FollowPolicy]::AutoTarget(1) -eq 2)
        Check 'auto target 2 -> 1' ([LogiSync.FollowPolicy]::AutoTarget(2) -eq 1)

        # Target resolution. Resolve(stayCur, stayNames, stayParts, goneCur, goneNames, goneParts, goneIsKb, learned)
        function Resolve($sc, $sn, $sp, $gc, $gn, $gp, $kb, $learned) {
            $d = $null; $c = $false; $w = $null
            $count = 0; if ($gn) { $count = $gn.Count } elseif ($gp) { $count = $gp.Count }
            $ch = [LogiSync.FollowPolicy]::ResolveTarget($sc, [string[]]$sn, [bool[]]$sp, $gc, [string[]]$gn, [bool[]]$gp, $count, $kb, $learned, [ref]$d, [ref]$c, [ref]$w)
            return @{ ch = $ch; dest = $d; certain = $c; why = $w }
        }
        $N3 = @('LAPTOP', 'DESKTOP', 'IPAD'); $none = @($false, $false, $false)
        $both = @($true, $true, $false)      # laptop + desktop run logi-sync, iPad doesn't

        # --- the reported bug: devices kept going to the iPad
        $r = Resolve 0 $N3 $both 0 $N3 $both $true 'IPAD'
        Check 'kb leaves laptop: never the iPad, even if "learned" says so' ($r.ch -eq 2 -and $r.certain)
        $r = Resolve 1 $N3 $both 1 $N3 $both $false $null
        Check 'mouse pressed on desktop (2->3 iPad->1): keyboard goes to laptop' ($r.ch -eq 1 -and $r.certain)
        $r = Resolve 0 $N3 $both 0 $N3 $both $false $null
        Check 'mouse pressed on laptop (1->2): keyboard goes to desktop' ($r.ch -eq 2)
        $r = Resolve 0 $N3 $both 0 @('LAPTOP', '', '') $both $true $null
        Check 'partial/garbled names on the gone device: marks still decide' ($r.ch -eq 2)

        # --- reported bug #2: a stray mark on the iPad channel of ONE device
        $mouseBad = @($true, $true, $true); $kbOk = @($true, $true, $false)
        $r = Resolve 1 $N3 $kbOk 1 $N3 $mouseBad $false $null
        Check 'mouse (stray iPad mark) pressed on desktop: keyboard -> laptop, not iPad' ($r.ch -eq 1)
        $r = Resolve 1 $N3 $mouseBad 1 $N3 $kbOk $true 'IPAD'
        Check 'keyboard leaves desktop, mouse has stray iPad mark + learned iPad: mouse -> laptop' ($r.ch -eq 1)

        # --- before marks exist on other machines (first run)
        $r = Resolve 0 $N3 @($true, $false, $false) 0 $N3 @($true, $false, $false) $true $null
        Check 'no marks yet, kb leads: lowest other paired channel, not learned' ($r.ch -eq 2 -and -not $r.certain)
        $r = Resolve 1 $N3 @($false, $true, $false) 1 $N3 @($false, $true, $false) $false $null
        Check 'no marks yet, mouse leads: next channel' ($r.ch -eq 3)

        # --- general
        $std = @('LAPTOP', 'DESKTOP', '')
        $r = Resolve 0 $std $none 0 $std $none $true $null
        Check 'two computers, no marks: the other one' ($r.ch -eq 2)
        $r = Resolve 0 @('LAPTOP', '', 'DESKTOP') @($true, $false, $true) 0 @('LAPTOP', '', 'DESKTOP') @($true, $false, $true) $true $null
        Check 'desktop on channel 3: -> ch3' ($r.ch -eq 3)
        $r = Resolve 1 @('LAPTOP', 'DESKTOP', '') @($true, $true, $false) 2 @('LAPTOP', '', 'DESKTOP') @($true, $false, $true) $false $null
        Check 'mismatched numbering: by name (mouse desktop=3 -> laptop=1)' ($r.ch -eq 1)
        $r = Resolve 0 $N3 @($true, $true, $true) 0 $N3 @($true, $true, $true) $true 'IPAD'
        Check 'three machines all running logi-sync: learned breaks the tie' ($r.ch -eq 3)
        $r = Resolve 0 @() @() 0 @() @() $true $null
        Check 'no names, no marks: fallback 1 <-> 2' ($r.ch -eq 2)
        if ($fail) { Write-Host "$fail check(s) failed"; exit 1 } else { Write-Host 'all checks passed' }
    }
}
