using System.Diagnostics;
using System.Diagnostics.Eventing.Reader;
using System.IO;
using System.Management;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using AntiCheatAgent.Models;
using Microsoft.Win32;

namespace AntiCheatAgent.Services;

/// <summary>
/// Deep PC profile pass: boot/BIOS identity, GPU, VPN adapters, recycle-bin age,
/// Windows install date, approximate country (public IP), focused window title,
/// local user accounts, recording software, recent file activity and PowerShell
/// history patterns. Everything collected here is disclosed on the consent
/// screen — this is an on-device forensic summary, not stealth monitoring.
/// </summary>
public static class PcProfileScanner
{
    public sealed record AccountInfo(string Name, bool Disabled, string Sid);
    public sealed record RecorderInfo(string Name, int Pid);
    public sealed record RecentFile(string Name, string Path, string Kind, long SizeKb, string ModifiedAt);

    public sealed class Profile
    {
        // boot / firmware
        public string BootTime { get; set; } = "";
        public string BootAge { get; set; } = "";
        public string BiosVendor { get; set; } = "";
        public string BiosVersion { get; set; } = "";
        public string BoardProduct { get; set; } = "";
        public string BoardManufacturer { get; set; } = "";
        public string BootEntry { get; set; } = "";
        public string BootEntryHash { get; set; } = "";

        // install / os
        public string InstallDate { get; set; } = "";
        public string WindowsBuild { get; set; } = "";

        // hardware
        public string Gpu { get; set; } = "";
        public long GpuVramMb { get; set; }

        // network
        public bool Vpn { get; set; }
        public List<string> VpnAdapters { get; set; } = new();
        public string Country { get; set; } = "";
        public string Ip { get; set; } = "";

        // recycle bin
        public double? RecycleAgeDays { get; set; }

        // window
        public string WindowText { get; set; } = "";

        // accounts
        public bool CurrentUserAdmin { get; set; }
        public List<AccountInfo> Accounts { get; set; } = new();
        public bool GuestEnabled { get; set; }

        // recording software
        public List<RecorderInfo> Recorders { get; set; } = new();

        // recent file activity
        public List<RecentFile> RecentFiles { get; set; } = new();

        // powershell
        public int PsHistoryLines { get; set; }
        public List<string> PsSuspicious { get; set; } = new();
    }

    /* ------------------------------------------------------------ collect */

    public static Profile Collect()
    {
        var p = new Profile();
        try { Boot(p); } catch { /* best effort */ }
        try { Hardware(p); } catch { }
        try { Network(p); } catch { }
        try { Recycle(p); } catch { }
        try { WindowFocus(p); } catch { }
        try { Accounts(p); } catch { }
        try { Recorders(p); } catch { }
        try { RecentFileActivity(p); } catch { }
        try { PowerShell(p); } catch { }
        return p;
    }

    /* -------------------------------------------------------- boot/firmware */

    private static void Boot(Profile p)
    {
        // last boot time (WMI first, tick-count fallback)
        try
        {
            foreach (var o in Query("SELECT LastBootUpTime FROM Win32_OperatingSystem"))
            {
                var t = o["LastBootUpTime"]?.ToString();
                if (string.IsNullOrEmpty(t)) continue;
                DateTime boot = DateTime.MinValue;
                try { boot = ManagementDateTimeConverter.ToDateTime(t); }
                catch { DateTime.TryParse(t, out boot); }
                if (boot != DateTime.MinValue && boot.Year > 2000)
                {
                    p.BootTime = boot.ToString("yyyy-MM-dd HH:mm:ss");
                    var age = DateTime.Now - boot;
                    p.BootAge = age.TotalDays >= 1
                        ? $"{(int)age.TotalDays}d {age.Hours}h"
                        : $"{age.Hours}h {age.Minutes}m";
                    break;
                }
            }
        }
        catch { }
        if (string.IsNullOrEmpty(p.BootTime) || string.IsNullOrEmpty(p.BootAge))
        {
            try
            {
                var boot = DateTime.Now - TimeSpan.FromMilliseconds(Environment.TickCount64);
                p.BootTime = boot.ToString("yyyy-MM-dd HH:mm:ss");
                var age = DateTime.Now - boot;
                p.BootAge = $"{age.Hours}h {age.Minutes}m";
            }
            catch { /* leave blank rather than abort the profile */ }
        }

        // firmware / board identity from registry (no WMI needed)
        try
        {
            using var key = Registry.LocalMachine.OpenSubKey(@"HARDWARE\DESCRIPTION\System\BIOS");
            if (key != null)
            {
                p.BiosVendor = Str(key.GetValue("SystemBiosManufacturer"))
                              ?? Str(key.GetValue("BIOSVendor")) ?? "";
                p.BiosVersion = Str(key.GetValue("SystemBiosVersion"))
                                ?? Str(key.GetValue("BIOSVersion")) ?? "";
                p.BoardManufacturer = Str(key.GetValue("BaseBoardManufacturer")) ?? "";
                p.BoardProduct = Str(key.GetValue("BaseBoardProduct")) ?? "";
                if (string.IsNullOrEmpty(p.BiosVendor))
                    p.BiosVendor = Str(key.GetValue("SystemManufacturer")) ?? "";
                if (string.IsNullOrEmpty(p.BoardManufacturer))
                    p.BoardManufacturer = Str(key.GetValue("SystemManufacturer")) ?? "";
            }
        }
        catch { }

        // Windows install date + build
        try
        {
            using var key = Registry.LocalMachine.OpenSubKey(
                @"SOFTWARE\Microsoft\Windows NT\CurrentVersion");
            if (key != null)
            {
                var raw = key.GetValue("InstallDate");
                var secs = raw is long l ? l : raw is int i32 ? i32 : 0L;
                if (secs > 0)
                    p.InstallDate = DateTimeOffset.FromUnixTimeSeconds(secs)
                        .LocalDateTime.ToString("yyyy-MM-dd");
                p.WindowsBuild = $"{Str(key.GetValue("DisplayVersion"))} build {Str(key.GetValue("CurrentBuild"))}";
            }
        }
        catch { }

        // boot manager entry + hash (boot sequence evidence)
        var drive = Environment.GetEnvironmentVariable("SystemDrive") ?? "C:";
        string[] candidates =
        {
            drive + @"\Windows\EFI\Microsoft\Boot\bootmgfw.efi",
            drive + @"\bootmgr",
            drive + @"\Windows\System32\winload.efi",
        };
        foreach (var path in candidates)
        {
            try
            {
                if (!File.Exists(path)) continue;
                p.BootEntry = path;
                using var fs = File.OpenRead(path);
                p.BootEntryHash = Convert.ToHexString(
                    System.Security.Cryptography.SHA256.HashData(fs))[..16].ToLowerInvariant();
                break;
            }
            catch { }
        }
    }

    /* ----------------------------------------------------------- hardware */

    private static void Hardware(Profile p)
    {
        foreach (var o in Query("SELECT Name, AdapterRAM FROM Win32_VideoController"))
        {
            var name = Str(o["Name"]);
            if (string.IsNullOrWhiteSpace(name)) continue;
            p.Gpu = name;
            if (o["AdapterRAM"] is uint vram && vram > 0)
                p.GpuVramMb = vram / (1024 * 1024);
            break;
        }
        if (string.IsNullOrEmpty(p.Gpu)) p.Gpu = "Unknown GPU";
    }

    /* ----------------------------------------------------------- network */

    private static readonly string[] VpnKeywords =
    {
        "vpn", "wireguard", "nordlynx", "nordvpn", "expressvpn", "protonvpn",
        "surfshark", "openvpn", "hamachi", "radmin", "tailscale", "zerotier",
        "tap-windows", "anyconnect", "forticlient", "windscribe", "purevpn",
        "cyberghost", "ipvanish", "mullvad", "hideaway", "windscribe",
    };

    private static void Network(Profile p)
    {
        foreach (var o in Query(
            "SELECT Name, Description, NetConnectionID, NetEnabled, NetConnectionStatus FROM Win32_NetworkAdapter"))
        {
            var hay = $"{Str(o["Name"])} {Str(o["Description"])} {Str(o["NetConnectionID"])}"
                .ToLowerInvariant();
            if (string.IsNullOrWhiteSpace(hay.Trim())) continue;
            if (!VpnKeywords.Any(k => hay.Contains(k))) continue;

            // ignore disabled/vanished adapters when the status is known
            var status = o["NetConnectionStatus"];
            if (status is ushort s && s == 0) continue; // disconnected-only adapters are stale
            var label = Str(o["NetConnectionID"]) ?? Str(o["Name"]) ?? "adapter";
            if (!p.VpnAdapters.Contains(label)) p.VpnAdapters.Add(label);
        }
        p.Vpn = p.VpnAdapters.Count > 0;

        // approximate country via public IP (fast, timeout-guarded)
        try
        {
            using var http = new HttpClient();
            http.Timeout = TimeSpan.FromSeconds(4);
            http.DefaultRequestHeaders.UserAgent.ParseAdd("TournamentAntiCheat/1.0");
            var json = http.GetStringAsync("https://ipapi.co/json/", CancellationToken.None)
                .GetAwaiter().GetResult();
            using var doc = JsonDocument.Parse(json);
            p.Country = doc.RootElement.TryGetProperty("country_name", out var c) ? c.GetString() ?? "" : "";
            p.Ip = doc.RootElement.TryGetProperty("ip", out var ip) ? ip.GetString() ?? "" : "";
        }
        catch { p.Country = ""; p.Ip = ""; }
    }

    /* -------------------------------------------------------- recycle bin */

    private static void Recycle(Profile p)
    {
        try
        {
            var dir = new DirectoryInfo(
                Path.Combine(Environment.GetEnvironmentVariable("SystemDrive") ?? "C:", "$Recycle.Bin"));
            if (dir.Exists)
                p.RecycleAgeDays = Math.Round((DateTime.Now - dir.LastWriteTime).TotalDays, 1);
        }
        catch { p.RecycleAgeDays = null; }
    }

    /* ------------------------------------------------------ window focus */

    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);

    private const uint GwHwndNext = 2;

    private static void WindowFocus(Profile p)
    {
        try
        {
            var own = Process.GetCurrentProcess().MainWindowHandle;
            var hwnd = GetForegroundWindow();
            var sb = new StringBuilder(256);

            // if our own window is focused, walk the z-order for the next titled window
            for (var i = 0; i < 12; i++)
            {
                if (hwnd == IntPtr.Zero) break;
                if (hwnd != own)
                {
                    GetWindowText(hwnd, sb, sb.Capacity);
                    var title = sb.ToString().Trim();
                    if (title.Length > 0) { p.WindowText = title.Length > 120 ? title[..120] : title; return; }
                }
                hwnd = GetWindow(hwnd, GwHwndNext);
            }
            p.WindowText = "(none focused)";
        }
        catch { p.WindowText = ""; }
    }

    /* ---------------------------------------------------------- accounts */

    private static void Accounts(Profile p)
    {
        try
        {
            using var id = WindowsIdentity.GetCurrent();
            p.CurrentUserAdmin = new WindowsPrincipal(id).IsInRole(
                WindowsBuiltInRole.Administrator);
        }
        catch { }

        foreach (var o in Query(
            "SELECT Name, Disabled, SID FROM Win32_UserAccount WHERE LocalAccount = True"))
        {
            var name = Str(o["Name"]);
            if (string.IsNullOrEmpty(name)) continue;
            var disabled = o["Disabled"] is bool d && d;
            var sid = Str(o["SID"]) ?? "";
            p.Accounts.Add(new AccountInfo(name, disabled, sid));
            if (name.Equals("Guest", StringComparison.OrdinalIgnoreCase) && !disabled)
                p.GuestEnabled = true;
        }
        if (p.Accounts.Count > 24) p.Accounts = p.Accounts.Take(24).ToList();
    }

    /* ----------------------------------------------- recording software */

    private static readonly string[] RecorderNames =
    {
        "obs64", "obs32", "obs", "bdcam", "bandicam", "fraps", "xsplit",
        "xsplit.core", "action", "dxtory", "playstv", "medal", "rtss",
        "msiafterburner", "shadowplay",
    };

    private static void Recorders(Profile p)
    {
        foreach (var proc in Process.GetProcesses())
        {
            try
            {
                var name = proc.ProcessName.ToLowerInvariant();
                if (RecorderNames.Contains(name))
                    p.Recorders.Add(new RecorderInfo(proc.ProcessName, proc.Id));
            }
            catch { /* process exited mid-walk */ }
            finally { proc.Dispose(); }
        }
    }

    /* --------------------------------------------- recent file activity */

    private static void RecentFileActivity(Profile p)
    {
        var roots = new[]
        {
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile) + @"\Downloads",
            Path.GetTempPath(),
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData) + @"\Programs",
        };
        var exts = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            { ".exe", ".dll", ".sys", ".jar", ".bat", ".ps1", ".scr", ".cmd" };
        var cutoff = DateTime.Now.AddHours(-72);
        var examined = 0;
        var found = new List<RecentFile>();

        foreach (var root in roots.Distinct())
        {
            if (found.Count >= 40) break;
            if (!Directory.Exists(root)) continue;
            try
            {
                foreach (var file in Directory.EnumerateFiles(
                    root, "*", SearchOption.AllDirectories))
                {
                    if (++examined > 120_000) break;
                    try
                    {
                        var info = new FileInfo(file);
                        if (info.LastWriteTime < cutoff) continue;
                        if (!exts.Contains(info.Extension)) continue;
                        found.Add(new RecentFile(
                            info.Name, info.FullName,
                            info.Extension.TrimStart('.').ToLowerInvariant(),
                            Math.Max(1, info.Length / 1024),
                            info.LastWriteTime.ToString("yyyy-MM-dd HH:mm")));
                        if (found.Count >= 40) break;
                    }
                    catch { }
                }
            }
            catch { /* access denied somewhere in the tree */ }
            if (examined > 120_000) break;
        }

        p.RecentFiles = found
            .OrderByDescending(f => f.ModifiedAt)
            .Take(40)
            .ToList();
    }

    /* ------------------------------------------------------- powershell */

    // strong signals: likely cheat/dropper automation
    private static readonly string[] PsStrong =
    {
        "downloadstring", "frombase64", "invoke-expression", "iex(",
        "amsi", "set-mppreference", "certutil -urlcache", "bitsadmin",
        "new-object net.webclient", "invoke-command",
    };
    // weak signals: worth surfacing but common in admin scripts
    private static readonly string[] PsWeak =
    {
        "-enc ", "-encodedcommand", "executionpolicy bypass", "-ep bypass",
        "-w hidden", "-windowstyle hidden", "invoke-webrequest",
        "curl ", "wget ", "schtasks", "reg add", "add-type",
        "reflection.assembly", "hidden",
    };

    private static void PowerShell(Profile p)
    {
        var lines = new List<string>();

        // 1) console history file (tail)
        try
        {
            var history = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                @"Microsoft\Windows\PowerShell\PSConsoleHost_history.txt");
            if (File.Exists(history))
            {
                lines.AddRange(File.ReadLines(history).TakeLast(400));
                p.PsHistoryLines = lines.Count;
            }
        }
        catch { }

        // 2) script-block log (last events only, time-boxed)
        try
        {
            var query = new EventLogQuery(
                "Microsoft-Windows-PowerShell/Operational", PathType.LogName,
                "*[System[(EventID=4104)]]") { ReverseDirection = true };
            using var reader = new EventLogReader(query);
            var watch = Stopwatch.StartNew();
            var read = 0;
            EventRecord rec;
            while (read < 80 && watch.Elapsed < TimeSpan.FromSeconds(6) &&
                   (rec = reader.ReadEvent()) != null)
            {
                read++;
                using (rec)
                {
                    var desc = rec.FormatDescription() ?? "";
                    if (desc.Length > 0)
                        lines.Add(desc.Length > 2000 ? desc[..2000] : desc);
                }
            }
        }
        catch { /* log absent or access denied */ }

        // 3) pattern match (only matches are reported)
        foreach (var raw in lines)
        {
            if (p.PsSuspicious.Count >= 6) break;
            var line = raw.Replace('\r', ' ').Replace('\n', ' ').Trim();
            if (line.Length < 4) continue;
            var lower = line.ToLowerInvariant();

            var strong = PsStrong.FirstOrDefault(s => lower.Contains(s));
            var weak = strong == null ? PsWeak.FirstOrDefault(s => lower.Contains(s)) : null;
            var hit = strong ?? weak;
            if (hit == null) continue;

            var snippet = line.Length > 160 ? line[..160] + "…" : line;
            p.PsSuspicious.Add($"[{hit}] {snippet}");
        }
    }

    /* ----------------------------------------------------------- helpers */

    private static List<ManagementObject> Query(string wql)
    {
        var list = new List<ManagementObject>();
        try
        {
            using var searcher = new ManagementObjectSearcher(wql);
            foreach (var o in searcher.Get()) list.Add((ManagementObject)o);
        }
        catch { }
        return list;
    }

    private static string? Str(object? value)
    {
        if (value is string[] arr)
            value = string.Join(" / ", arr.Where(s => !string.IsNullOrWhiteSpace(s)));
        var s = value?.ToString();
        if (string.IsNullOrWhiteSpace(s)) return null;
        s = s.Trim();
        // some registry values come back with \0 separators
        s = s.Replace('\0', ' ').Trim();
        return s.Length == 0 ? null : s;
    }

    /* ---------------------------------------------------------- findings */

    public static List<Finding> ToFindings(Profile p)
    {
        var findings = new List<Finding>();

        // accounts — full listing (info) + anomalies
        if (p.Accounts.Count > 0)
        {
            var names = string.Join(", ", p.Accounts.Select(a =>
                a.Disabled ? $"{a.Name} (disabled)" : a.Name));
            findings.Add(new Finding
            {
                Id = "pc-accounts",
                Category = "accounts",
                Severity = Severity.Info,
                Title = $"{p.Accounts.Count} local account(s) found",
                Detail = $"Windows user accounts present on this PC: {names}." +
                         (p.CurrentUserAdmin ? " Scan is running with administrator rights." : ""),
                Evidence = names,
                Kind = "accounts",
            });
        }
        if (p.GuestEnabled)
        {
            findings.Add(new Finding
            {
                Id = "pc-guest",
                Category = "accounts",
                Severity = Severity.Medium,
                Title = "Guest account is enabled",
                Detail = "The built-in Guest account is active — a common way to share " +
                         "a machine between players to hide a cheat profile.",
                Evidence = "Guest account Enabled",
                Kind = "accounts",
            });
        }

        // recording software
        foreach (var r in p.Recorders.DistinctBy(x => x.Name.ToLowerInvariant()))
        {
            findings.Add(new Finding
            {
                Id = $"pc-rec-{r.Name.ToLowerInvariant()}",
                Category = "recording",
                Severity = Severity.Low,
                Title = $"Recording software running: {r.Name}",
                Detail = $"{r.Name} (PID {r.Pid}) was active during the scan. " +
                         "Recording/overlay tools can also capture or inject into the game.",
                Evidence = $"{r.Name}.exe PID {r.Pid}",
                Kind = "recording",
            });
        }

        // VPN adapters
        if (p.Vpn)
        {
            findings.Add(new Finding
            {
                Id = "pc-vpn",
                Category = "network",
                Severity = Severity.Low,
                Title = "VPN network adapter detected",
                Detail = $"Active VPN adapter(s): {string.Join(", ", p.VpnAdapters)}. " +
                         "Tournament rules may restrict VPN use.",
                Evidence = string.Join(", ", p.VpnAdapters),
                Kind = "checks",
            });
        }

        // powershell history
        if (p.PsSuspicious.Count > 0)
        {
            var strong = p.PsSuspicious.Any(s =>
                PsStrong.Any(k => s.StartsWith($"[{k}]")));
            findings.Add(new Finding
            {
                Id = "pc-powershell",
                Category = "powershell",
                Severity = strong ? Severity.Medium : Severity.Low,
                Title = $"{p.PsSuspicious.Count} suspicious PowerShell pattern(s) in history",
                Detail = "Recent PowerShell activity matched cheat-install / payload-download " +
                         "patterns (history + script-block log).",
                Evidence = string.Join("  |  ", p.PsSuspicious.Take(3)),
                Kind = "checks",
            });
        }

        // boot manager integrity
        if (string.IsNullOrEmpty(p.BootEntry))
        {
            var admin = p.CurrentUserAdmin;
            findings.Add(new Finding
            {
                Id = "pc-boot-entry",
                Category = "integrity",
                Severity = admin ? Severity.High : Severity.Medium,
                Title = "Boot manager file not found",
                Detail = admin
                    ? "None of the expected boot files (bootmgfw.efi, bootmgr, winload.efi) could be read with admin " +
                      "rights — boot chain integrity could not be verified."
                    : "Boot files could not be read from this account (permission limited) — boot chain integrity " +
                      "was not verified. Re-run elevated for a full check.",
                Evidence = "bootmgfw.efi / bootmgr / winload.efi not readable",
                Kind = "checks",
            });
        }

        return findings;
    }

    /* --------------------------------------------- system info merge */

    public static void MergeInto(Dictionary<string, object> system, Profile p)
    {
        system["bootTime"] = p.BootTime;
        system["bootAge"] = p.BootAge;
        system["biosVendor"] = p.BiosVendor;
        system["biosVersion"] = p.BiosVersion;
        system["boardProduct"] = p.BoardProduct;
        system["boardManufacturer"] = p.BoardManufacturer;
        system["bootEntry"] = p.BootEntry;
        system["bootEntryHash"] = p.BootEntryHash;
        system["installDate"] = p.InstallDate;
        system["windowsBuild"] = p.WindowsBuild;
        system["gpu"] = p.Gpu;
        system["gpuVramMb"] = p.GpuVramMb;
        system["vpn"] = p.Vpn;
        system["vpnAdapters"] = p.VpnAdapters;
        system["country"] = p.Country;
        system["ip"] = p.Ip;
        system["recycleAgeDays"] = p.RecycleAgeDays ?? -1;
        system["windowText"] = p.WindowText;
        system["currentUserAdmin"] = p.CurrentUserAdmin;
        system["accounts"] = p.Accounts.Select(a => new
        {
            name = a.Name,
            disabled = a.Disabled,
        }).ToList();
        system["guestEnabled"] = p.GuestEnabled;
        system["recorders"] = p.Recorders.Select(r => new
        {
            name = r.Name,
            pid = r.Pid,
        }).ToList();
        system["recentFiles"] = p.RecentFiles.Select(f => new
        {
            name = f.Name,
            path = f.Path,
            kind = f.Kind,
            sizeKb = f.SizeKb,
            modifiedAt = f.ModifiedAt,
        }).ToList();
        system["psHistoryLines"] = p.PsHistoryLines;
        system["psSuspicious"] = p.PsSuspicious;
    }

    /* ------------------------------------------------------- AI opinion */

    /// <summary>
    /// Deterministic on-device analysis narrative (the "AI opinion" pane).
    /// Built only from this scan's own evidence — no data leaves the report.
    /// </summary>
    public static Finding BuildAiOpinion(Profile p, List<Finding> findings,
        string verdict, int score, int filesScanned, int signatureChecks)
    {
        var serious = findings.Where(f => f.Severity >= Severity.High).ToList();
        var medium = findings.Where(f => f.Severity == Severity.Medium).ToList();
        var sb = new StringBuilder();

        sb.Append($"Heuristic pass over {filesScanned} files and {signatureChecks} signature checks; ");
        sb.Append($"{findings.Count} finding(s) weighted to {score} points. ");

        if (verdict == "detected")
        {
            sb.Append("Verdict DETECTED: high-weight cheat signals are present");
            if (serious.Count > 0)
                sb.Append($" — {string.Join("; ", serious.Take(3).Select(f => f.Title))}");
            sb.Append(". ");
        }
        else if (verdict == "suspicious")
        {
            sb.Append("Verdict SUSPICIOUS: enough medium-weight signals accumulated");
            if (medium.Count > 0)
                sb.Append($" ({string.Join("; ", medium.Take(3).Select(f => f.Title))})");
            sb.Append(". ");
        }
        else
        {
            sb.Append("Verdict CLEAN: no cheat-weighted signals crossed the threshold. ");
        }

        if (p.RecentFiles.Count > 0)
            sb.Append($"{p.RecentFiles.Count} executable(s) were dropped in watched folders within 72h. ");
        if (p.Recorders.Count > 0)
            sb.Append($"{p.Recorders.Count} recording/overlay tool(s) running. ");
        if (p.GuestEnabled) sb.Append("Guest account enabled. ");
        if (p.PsSuspicious.Count > 0)
            sb.Append($"{p.PsSuspicious.Count} PowerShell pattern hit(s). ");
        if (string.IsNullOrEmpty(p.Country))
            sb.Append("Country lookup unavailable (offline). ");

        return new Finding
        {
            Id = "pc-ai-opinion",
            Category = "analysis",
            Severity = Severity.Info,
            Title = "Analysis opinion",
            Detail = sb.ToString().Trim(),
            Evidence = $"verdict={verdict} score={score}",
            Kind = "ai",
        };
    }
}
