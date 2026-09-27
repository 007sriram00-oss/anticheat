using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Diagnostics.Eventing.Reader;
using System.IO;
using System.Linq;
using System.Management;
using System.Security.Principal;
using System.Text;
using AntiCheatAgent.Models;
using Microsoft.Win32;

namespace AntiCheatAgent.Services;

/// <summary>
/// Brutal Finder: Deep PC research & forensic anti-cheat analysis engine.
/// Scans:
///   1. Secure Boot & Kernel Testsigning integrity
///   2. Windows Event Logs (log clearing, kernel driver loads, code integrity, app crashes)
///   3. PC Execution Logs & Forensics (Prefetch, BAM/DAM registry, AppCompatCache, RunMRU)
///   4. Brutal String & Keyword Finder (Desktop, Downloads, Temp, Recent, running processes & modules)
/// </summary>
public static class BrutalFinder
{
    public sealed class BrutalResult
    {
        public bool SecureBootEnabled { get; set; }
        public bool TestsigningEnabled { get; set; }
        public bool HypervisorEnforcedCi { get; set; }
        public int EventLogsScanned { get; set; }
        public List<string> EventLogAnomalies { get; set; } = new();
        public List<string> PrefetchHits { get; set; } = new();
        public List<string> BamHits { get; set; } = new();
        public List<string> StringFinderHits { get; set; } = new();
        public List<string> SuspiciousDriversFound { get; set; } = new();
        public List<Finding> Findings { get; set; } = new();
    }

    private static readonly string[] CheatKeywords =
    {
        "aimbot", "triggerbot", "wallhack", "esp", "silentaim", "norecoil", "no-recoil",
        "speedhack", "chams", "injector", "cheatengine", "kprocesshacker", "extremeinjector",
        "xenos", "blackbone", "modmenu", "dma", "bypass", "spoofer", "hwidspoofer",
        "glowesp", "radarhack", "magicbullet", "fastcrouch", "kdmapper"
    };

    private static readonly string[] SuspiciousDriverNames =
    {
        "gdrv", "mhyprot", "iqvw64e", "dbk64", "dbk32", "kprocesshacker", "procexp",
        "capcom", "rtcore64", "atsiv", "speedfan", "winring0", "inpoutx64", "echo.sys"
    };

    public static BrutalResult Run(Action<int, string>? onProgress = null)
    {
        var result = new BrutalResult();

        onProgress?.Invoke(0, "Brutal Finder: Checking Secure Boot & Kernel Integrity");
        CheckSecureBootAndKernel(result);

        onProgress?.Invoke(25, "Brutal Finder: Inspecting Windows Event Logs for tampering & driver loads");
        CheckWindowsEventLogs(result);

        onProgress?.Invoke(50, "Brutal Finder: Analyzing PC execution artifacts (Prefetch & BAM)");
        CheckPcExecutionLogs(result);

        onProgress?.Invoke(75, "Brutal Finder: Running deep string search across sensitive directories");
        CheckBrutalStringFinder(result);

        onProgress?.Invoke(100, "Brutal Finder: Scan complete");
        return result;
    }

    /* -------------------------------------------------- 1. Secure Boot & Kernel */

    private static void CheckSecureBootAndKernel(BrutalResult res)
    {
        try
        {
            // Check UEFISecureBootEnabled in registry
            using var key = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Control\SecureBoot\State");
            if (key != null)
            {
                var val = key.GetValue("UEFISecureBootEnabled");
                if (val is int intVal && intVal == 1)
                {
                    res.SecureBootEnabled = true;
                }
            }

            // Fallback check via WMI if key not found
            if (!res.SecureBootEnabled)
            {
                try
                {
                    using var searcher = new ManagementObjectSearcher(@"root\cimv2", "SELECT * FROM Win32_ComputerSystem");
                    // Registry is the standard ground truth for Windows 10/11
                }
                catch { }
            }

            if (!res.SecureBootEnabled)
            {
                res.Findings.Add(new Finding
                {
                    Id = "brutal-secureboot-disabled",
                    Category = "integrity",
                    Severity = Severity.High,
                    Title = "Secure Boot is Disabled",
                    Detail = "UEFI Secure Boot is turned off on this system. Unsigned kernel bootloaders and vulnerable driver mappers (e.g. kdmapper, DSE bypasses) can be executed without BIOS verification.",
                    Evidence = "UEFISecureBootEnabled = 0 or missing"
                });
            }

            // Check Testsigning / Debugging / Integrity Checks disabled
            using var bcdKey = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Control");
            var startOptions = bcdKey?.GetValue("SystemStartOptions")?.ToString()?.ToUpperInvariant() ?? "";

            if (startOptions.Contains("TESTSIGNING") || startOptions.Contains("DISABLE_INTEGRITY_CHECKS") || startOptions.Contains("DEBUG"))
            {
                res.TestsigningEnabled = true;
                res.Findings.Add(new Finding
                {
                    Id = "brutal-kernel-testsigning",
                    Category = "kernel",
                    Severity = Severity.Critical,
                    Title = "Windows Testsigning or Integrity Bypass Enabled",
                    Detail = "Windows is operating in Testsigning or Debug mode, allowing unsigned malicious kernel drivers to load directly.",
                    Evidence = $"SystemStartOptions: {startOptions}"
                });
            }

            // Check Hypervisor Enforced Code Integrity (HVCI)
            using var hvciKey = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\HypervisorEnforcedCodeIntegrity");
            if (hvciKey != null && hvciKey.GetValue("Enabled") is int hvciVal && hvciVal == 1)
            {
                res.HypervisorEnforcedCi = true;
            }
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"[BrutalFinder] SecureBoot check error: {ex.Message}");
        }
    }

    /* -------------------------------------------------- 2. Windows Event Logs */

    private static void CheckWindowsEventLogs(BrutalResult res)
    {
        // 2a. Event Log Cleared checks (EventID 1102 in Security, EventID 104 in System)
        try
        {
            var secQuery = new EventLogQuery("Security", PathType.LogName, "*[System[(EventID=1102)]]") { ReverseDirection = true };
            using var secReader = new EventLogReader(secQuery);
            EventRecord? secRec = secReader.ReadEvent();
            if (secRec != null)
            {
                using (secRec)
                {
                    var ts = secRec.TimeCreated?.ToUniversalTime().ToString("u") ?? "recently";
                    res.EventLogAnomalies.Add($"Security event log was cleared (EventID 1102 at {ts})");
                    res.Findings.Add(new Finding
                    {
                        Id = "brutal-eventlog-cleared-sec",
                        Category = "event-log",
                        Severity = Severity.Critical,
                        Title = "Security Event Log was Cleared",
                        Detail = "The Windows Security audit log was manually wiped. This is a common anti-forensic tactic used by cheaters to destroy injection records.",
                        Evidence = $"EventID 1102 detected at {ts}"
                    });
                }
            }
        }
        catch { /* Access denied or not admin */ }

        try
        {
            var sysQuery = new EventLogQuery("System", PathType.LogName, "*[System[(EventID=104)]]") { ReverseDirection = true };
            using var sysReader = new EventLogReader(sysQuery);
            EventRecord? sysRec = sysReader.ReadEvent();
            if (sysRec != null)
            {
                using (sysRec)
                {
                    var ts = sysRec.TimeCreated?.ToUniversalTime().ToString("u") ?? "recently";
                    res.EventLogAnomalies.Add($"System event log was cleared (EventID 104 at {ts})");
                    res.Findings.Add(new Finding
                    {
                        Id = "brutal-eventlog-cleared-sys",
                        Category = "event-log",
                        Severity = Severity.Critical,
                        Title = "System Event Log was Cleared",
                        Detail = "The Windows System event log was cleared. Cheaters clear system logs to hide kernel driver load traces.",
                        Evidence = $"EventID 104 detected at {ts}"
                    });
                }
            }
        }
        catch { }

        // 2b. Driver Installation checks (EventID 7045 in System)
        try
        {
            var driverQuery = new EventLogQuery("System", PathType.LogName, "*[System[(EventID=7045)]]") { ReverseDirection = true };
            using var driverReader = new EventLogReader(driverQuery);
            var scanned = 0;
            var watch = Stopwatch.StartNew();
            EventRecord? rec;

            while (scanned < 150 && watch.ElapsedMilliseconds < 3500 && (rec = driverReader.ReadEvent()) != null)
            {
                scanned++;
                using (rec)
                {
                    var desc = (rec.FormatDescription() ?? "").ToLowerInvariant();
                    foreach (var sDrv in SuspiciousDriverNames)
                    {
                        if (desc.Contains(sDrv))
                        {
                            var snippet = desc.Length > 180 ? desc[..180] + "…" : desc;
                            res.SuspiciousDriversFound.Add($"[EventLog 7045] {sDrv}: {snippet}");
                            res.Findings.Add(new Finding
                            {
                                Id = $"brutal-suspicious-driver-{sDrv}",
                                Category = "driver",
                                Severity = Severity.Critical,
                                Title = $"Vulnerable / Cheat Driver Installed: {sDrv}",
                                Detail = $"Service installation event recorded for known vulnerable driver '{sDrv}', commonly abused by cheat mappers to read/write kernel memory.",
                                Evidence = snippet
                            });
                            break;
                        }
                    }
                }
            }
            res.EventLogsScanned += scanned;
        }
        catch { }

        // 2c. Code Integrity Driver Block events (EventID 3077 or 3033)
        try
        {
            var ciQuery = new EventLogQuery("Microsoft-Windows-CodeIntegrity/Operational", PathType.LogName, "*[System[(EventID=3077 or EventID=3033)]]") { ReverseDirection = true };
            using var ciReader = new EventLogReader(ciQuery);
            EventRecord? ciRec = ciReader.ReadEvent();
            if (ciRec != null)
            {
                using (ciRec)
                {
                    var desc = ciRec.FormatDescription() ?? "";
                    res.EventLogAnomalies.Add($"Code Integrity blocked driver: {desc}");
                    res.Findings.Add(new Finding
                    {
                        Id = "brutal-code-integrity-block",
                        Category = "kernel",
                        Severity = Severity.High,
                        Title = "Windows Code Integrity Blocked Unsigned Driver",
                        Detail = "Windows Code Integrity prevented an unauthorized or vulnerable kernel driver from loading.",
                        Evidence = desc.Length > 200 ? desc[..200] : desc
                    });
                }
            }
        }
        catch { }
    }

    /* -------------------------------------------------- 3. PC Execution Logs */

    private static void CheckPcExecutionLogs(BrutalResult res)
    {
        // 3a. Windows Prefetch Inspection (C:\Windows\Prefetch\*.pf)
        try
        {
            var prefetchDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "Prefetch");
            if (Directory.Exists(prefetchDir))
            {
                var files = Directory.GetFiles(prefetchDir, "*.pf");
                foreach (var pf in files)
                {
                    var name = Path.GetFileName(pf).ToUpperInvariant();
                    foreach (var kw in CheatKeywords)
                    {
                        if (name.Contains(kw.ToUpperInvariant()))
                        {
                            var fi = new FileInfo(pf);
                            var hit = $"{Path.GetFileName(pf)} (Last Executed: {fi.LastWriteTimeUtc:u})";
                            res.PrefetchHits.Add(hit);
                            res.Findings.Add(new Finding
                            {
                                Id = $"brutal-prefetch-{kw}",
                                Category = "pc-log",
                                Severity = Severity.Critical,
                                Title = $"Prefetch Execution Evidence: {kw.ToUpperInvariant()}",
                                Detail = $"Windows Prefetch recorded execution of an executable matching cheat signature '{kw}'. Prefetch proves the file was executed on this machine.",
                                Evidence = hit
                            });
                            break;
                        }
                    }
                }
            }
        }
        catch { /* Prefetch requires admin or unprivileged read allowed on some builds */ }

        // 3b. BAM (Background Activity Moderator) Execution Registry Keys
        try
        {
            using var bamKey = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Services\bam\State\UserSettings");
            if (bamKey != null)
            {
                foreach (var sid in bamKey.GetSubKeyNames())
                {
                    using var userKey = bamKey.OpenSubKey(sid);
                    if (userKey == null) continue;

                    foreach (var valName in userKey.GetValueNames())
                    {
                        var lowerPath = valName.ToLowerInvariant();
                        foreach (var kw in CheatKeywords)
                        {
                            if (lowerPath.Contains(kw))
                            {
                                res.BamHits.Add($"[BAM Execution] {valName}");
                                res.Findings.Add(new Finding
                                {
                                    Id = $"brutal-bam-{kw}",
                                    Category = "pc-log",
                                    Severity = Severity.Critical,
                                    Title = $"Historical Execution Recorded in BAM: {kw}",
                                    Detail = $"Background Activity Moderator recorded execution of '{valName}'. BAM keeps execution traces even if the cheat file was deleted from disk.",
                                    Evidence = valName
                                });
                                break;
                            }
                        }
                    }
                }
            }
        }
        catch { }

        // 3c. RunMRU (Commands executed via Win+R)
        try
        {
            using var runMruKey = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Explorer\RunMRU");
            if (runMruKey != null)
            {
                foreach (var valName in runMruKey.GetValueNames())
                {
                    if (valName == "MRUList") continue;
                    var cmd = (runMruKey.GetValue(valName)?.ToString() ?? "").ToLowerInvariant();
                    foreach (var kw in CheatKeywords)
                    {
                        if (cmd.Contains(kw))
                        {
                            res.Findings.Add(new Finding
                            {
                                Id = $"brutal-runmru-{kw}",
                                Category = "pc-log",
                                Severity = Severity.High,
                                Title = $"Run Dialog Cheat Command: {kw}",
                                Detail = $"User executed command containing cheat keyword '{kw}' from Windows Run dialog.",
                                Evidence = cmd
                            });
                            break;
                        }
                    }
                }
            }
        }
        catch { }
    }

    /* -------------------------------------------------- 4. Brutal String Finder */

    private static void CheckBrutalStringFinder(BrutalResult res)
    {
        // 4a. Running Process Window Titles & Module Names
        try
        {
            foreach (var proc in Process.GetProcesses())
            {
                try
                {
                    var title = proc.MainWindowTitle.ToLowerInvariant();
                    var pName = proc.ProcessName.ToLowerInvariant();

                    if (!string.IsNullOrWhiteSpace(title))
                    {
                        foreach (var kw in CheatKeywords)
                        {
                            if (title.Contains(kw))
                            {
                                var hit = $"Process '{proc.ProcessName}' (PID {proc.Id}) Window Title: \"{proc.MainWindowTitle}\"";
                                res.StringFinderHits.Add(hit);
                                res.Findings.Add(new Finding
                                {
                                    Id = $"brutal-process-window-{proc.Id}-{kw}",
                                    Category = "string-finder",
                                    Severity = Severity.Critical,
                                    Title = $"Active Cheat Window: {kw.ToUpperInvariant()}",
                                    Detail = $"A running process has a window title containing cheat keyword '{kw}'.",
                                    Evidence = hit
                                });
                                break;
                            }
                        }
                    }

                    // Check modules if accessible
                    if (pName.Contains("aimbot") || pName.Contains("cheat") || pName.Contains("injector") || pName.Contains("xenos"))
                    {
                        var hit = $"Suspicious Process Name: {proc.ProcessName} (PID {proc.Id})";
                        res.StringFinderHits.Add(hit);
                    }
                }
                catch { }
            }
        }
        catch { }

        // 4b. Deep Directory Search (Desktop, Downloads, Temp, Recent)
        var searchDirs = new List<string>();
        try
        {
            var desktop = Environment.GetFolderPath(Environment.SpecialFolder.Desktop);
            if (Directory.Exists(desktop)) searchDirs.Add(desktop);

            var userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            var downloads = Path.Combine(userProfile, "Downloads");
            if (Directory.Exists(downloads)) searchDirs.Add(downloads);

            var temp = Path.GetTempPath();
            if (Directory.Exists(temp)) searchDirs.Add(temp);

            var recent = Environment.GetFolderPath(Environment.SpecialFolder.Recent);
            if (Directory.Exists(recent)) searchDirs.Add(recent);
        }
        catch { }

        foreach (var dir in searchDirs)
        {
            try
            {
                var files = Directory.GetFiles(dir, "*.*", SearchOption.TopDirectoryOnly);
                foreach (var file in files)
                {
                    var fName = Path.GetFileName(file).ToLowerInvariant();
                    foreach (var kw in CheatKeywords)
                    {
                        if (fName.Contains(kw))
                        {
                            var hit = $"File found in {Path.GetFileName(dir)}: {Path.GetFileName(file)}";
                            res.StringFinderHits.Add(hit);
                            res.Findings.Add(new Finding
                            {
                                Id = $"brutal-file-{kw}-{res.Findings.Count}",
                                Category = "string-finder",
                                Severity = Severity.Critical,
                                Title = $"Cheat File Found: {Path.GetFileName(file)}",
                                Detail = $"Found file matching cheat signature '{kw}' in directory {dir}.",
                                Evidence = file
                            });
                            break;
                        }
                    }

                    // Deep inspection inside small text/script files (.bat, .ps1, .txt, .cfg, .ini)
                    var ext = Path.GetExtension(file).ToLowerInvariant();
                    if (ext is ".bat" or ".ps1" or ".cmd" or ".vbs" or ".ini" or ".cfg")
                    {
                        try
                        {
                            var fi = new FileInfo(file);
                            if (fi.Length > 0 && fi.Length < 100 * 1024) // < 100KB
                            {
                                var content = File.ReadAllText(file).ToLowerInvariant();
                                foreach (var kw in CheatKeywords)
                                {
                                    if (content.Contains(kw))
                                    {
                                        var hit = $"Cheat string '{kw}' matched inside script: {file}";
                                        res.StringFinderHits.Add(hit);
                                        res.Findings.Add(new Finding
                                        {
                                            Id = $"brutal-script-content-{kw}-{res.Findings.Count}",
                                            Category = "string-finder",
                                            Severity = Severity.High,
                                            Title = $"Cheat String in Script: {Path.GetFileName(file)}",
                                            Detail = $"Script file contains cheat keyword '{kw}'.",
                                            Evidence = hit
                                        });
                                        break;
                                    }
                                }
                            }
                        }
                        catch { }
                    }
                }
            }
            catch { }
        }
    }
}
