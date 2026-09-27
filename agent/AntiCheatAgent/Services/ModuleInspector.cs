using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using AntiCheatAgent.Models;

namespace AntiCheatAgent.Services;

/// <summary>
/// Inspects loaded modules (DLLs) inside the running game process to find
/// injected / manually mapped modules. This is the core cheat-detection check.
/// </summary>
public static class ModuleInspector
{
    private const uint ProcessQueryInformation = 0x0400;
    private const uint ProcessVmRead = 0x0010;
    private const uint ListModulesAll = 0x03;

    [StructLayout(LayoutKind.Sequential)]
    private struct ModuleInfo
    {
        public IntPtr lpBaseOfDll;
        public uint SizeOfImage;
        public IntPtr EntryPoint;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, int dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CheckRemoteDebuggerPresent(IntPtr hProcess, out bool isDebuggerPresent);

    [DllImport("psapi.dll", SetLastError = true)]
    private static extern bool EnumProcessModulesEx(IntPtr hProcess, [Out] IntPtr[] lphModule, int cb, out int lpcbNeeded, uint dwFilterFlag);

    [DllImport("psapi.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int GetModuleFileNameEx(IntPtr hProcess, IntPtr hModule, StringBuilder lpFilename, int nSize);

    [DllImport("psapi.dll", SetLastError = true)]
    private static extern bool GetModuleInformation(IntPtr hProcess, IntPtr hModule, out ModuleInfo lpmodinfo, int cb);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool QueryFullProcessImageName(IntPtr hProcess, int dwFlags, StringBuilder lpExeName, ref int lpdwSize);

    public static (List<Finding> Findings, int ModulesScanned) Run(string gameName)
    {
        var findings = new List<Finding>();
        var processes = KnownCheatDb.GameProcesses.TryGetValue(gameName, out var names)
            ? names
            : Array.Empty<string>();

        if (processes.Length == 0)
        {
            findings.Add(new Finding
            {
                Id = "game-unknown",
                Category = "integrity",
                Severity = Severity.Info,
                Title = "Custom game — process inspection skipped",
                Detail = "This session uses a custom game without a known process name, so module inspection was " +
                         "skipped. Process, debugger and tool checks still ran.",
                Evidence = "",
            });
            return (findings, 0);
        }

        // Find the first running game process (emulator host counts too).
        var candidates = processes.Concat(KnownCheatDb.EmulatorProcesses).Distinct();
        Process? target = null;
        foreach (var name in candidates)
        {
            var procs = Process.GetProcessesByName(name);
            if (procs.Length > 0) { target = procs[0]; break; }
        }

        if (target == null)
        {
            findings.Add(new Finding
            {
                Id = "game-not-running",
                Category = "integrity",
                Severity = Severity.Low,
                Title = "Game process not running",
                Detail = $"No process for \"{gameName}\" was found. The scan could not verify loaded modules — " +
                         "run the agent while the game is open for full coverage.",
                Evidence = $"Looked for: {string.Join(", ", processes)}",
            });
            return (findings, 0);
        }

        try
        {
            var gamePath = QueryImagePath(target) ?? "";
            var gameDir = string.IsNullOrEmpty(gamePath) ? "" : Path.GetDirectoryName(gamePath) ?? "";
            var systemDir = Environment.GetFolderPath(Environment.SpecialFolder.System);

            // Remote debugger attached to the game?
            var hProc = OpenProcess(ProcessQueryInformation, false, target.Id);
            if (hProc != IntPtr.Zero)
            {
                try
                {
                    if (CheckRemoteDebuggerPresent(hProc, out var dbg) && dbg)
                    {
                        findings.Add(new Finding
                        {
                            Id = "game-debugger",
                            Category = "debugger",
                            Severity = Severity.Critical,
                            Title = "Debugger attached to game process",
                            Detail = "A debugger is attached to the running game process — a common vector for " +
                                     "reading opponent data or patching game code at runtime.",
                            Evidence = $"{Path.GetFileName(gamePath)} (PID {target.Id})",
                        });
                    }
                }
                finally { CloseHandle(hProc); }
            }

            // Enumerate modules.
            hProc = OpenProcess(ProcessQueryInformation | ProcessVmRead, false, target.Id);
            if (hProc == IntPtr.Zero)
            {
                findings.Add(new Finding
                {
                    Id = "game-access-denied",
                    Category = "integrity",
                    Severity = Severity.Medium,
                    Title = "Game process could not be inspected",
                    Detail = "OpenProcess failed for the game process (access denied). Re-run the agent as " +
                             "Administrator for module inspection coverage.",
                    Evidence = $"PID {target.Id}, Win32 error {Marshal.GetLastWin32Error()}",
                });
                return (findings, 0);
            }

            try
            {
                var buffer = new IntPtr[1024];
                if (!EnumProcessModulesEx(hProc, buffer, buffer.Length * IntPtr.Size, out var needed, ListModulesAll))
                {
                    findings.Add(new Finding
                    {
                        Id = "game-enum-failed",
                        Category = "integrity",
                        Severity = Severity.Medium,
                        Title = "Module enumeration failed",
                        Detail = "EnumProcessModulesEx failed for the game process.",
                        Evidence = $"Win32 error {Marshal.GetLastWin32Error()}",
                    });
                    return (findings, 0);
                }

                var count = Math.Min(needed / IntPtr.Size, buffer.Length);
                var thirdParty = new List<string>();
                var critical = new List<string>();
                var totalBytes = 0L;

                for (var i = 0; i < count; i++)
                {
                    var sb = new StringBuilder(1024);
                    if (GetModuleFileNameEx(hProc, buffer[i], sb, sb.Capacity) == 0) continue;
                    var modulePath = sb.ToString();
                    totalBytes++;

                    var fileName = Path.GetFileName(modulePath);
                    var dir = Path.GetDirectoryName(modulePath) ?? "";
                    var isSystem = dir.Equals(systemDir, StringComparison.OrdinalIgnoreCase) ||
                                   modulePath.StartsWith(systemDir, StringComparison.OrdinalIgnoreCase);
                    var isGame = !string.IsNullOrEmpty(gameDir) &&
                                 modulePath.StartsWith(gameDir, StringComparison.OrdinalIgnoreCase);

                    if (KnownCheatDb.SuspiciousModuleNames.Any(n =>
                            fileName.Equals(n, StringComparison.OrdinalIgnoreCase)))
                    {
                        critical.Add(modulePath);
                    }
                    else if (!isSystem && !isGame)
                    {
                        thirdParty.Add(modulePath);
                    }
                }

                foreach (var path in critical)
                {
                    findings.Add(new Finding
                    {
                        Id = $"mod-{Path.GetFileName(path)}",
                        Category = "injection",
                        Severity = Severity.Critical,
                        Title = "Known cheat module loaded in game",
                        Detail = "A DLL whose name matches known cheat/injection libraries is loaded inside the " +
                                 "game process.",
                        Evidence = path,
                    });
                }

                if (thirdParty.Count > 0)
                {
                    var shown = thirdParty.Take(8);
                    findings.Add(new Finding
                    {
                        Id = "mod-thirdparty",
                        Category = "injection",
                        Severity = Severity.Medium,
                        Title = $"{thirdParty.Count} third-party module(s) loaded in game",
                        Detail = "Modules outside the game folder and Windows system folders are loaded in the game " +
                                 "process. Overlays are common; anything unrecognized should be reviewed.",
                        Evidence = string.Join("\n", shown) + (thirdParty.Count > shown.Count() ? $"\n(+{thirdParty.Count - shown.Count()} more)" : ""),
                    });
                }
                else if (critical.Count == 0)
                {
                    findings.Add(new Finding
                    {
                        Id = "mod-clean",
                        Category = "injection",
                        Severity = Severity.Info,
                        Title = "Loaded modules look clean",
                        Detail = $"Inspected {count} modules in the game process — all are either system libraries " +
                                 "or part of the game installation.",
                        Evidence = gamePath,
                    });
                }

                // Game executable fingerprint (lets admins compare hashes across devices).
                if (!string.IsNullOrEmpty(gamePath) && File.Exists(gamePath))
                {
                    using var sha = System.Security.Cryptography.SHA256.Create();
                    using var fs = File.OpenRead(gamePath);
                    var hash = Convert.ToHexString(sha.ComputeHash(fs))[..16];
                    findings.Add(new Finding
                    {
                        Id = "game-hash",
                        Category = "integrity",
                        Severity = Severity.Info,
                        Title = "Game executable fingerprint",
                        Detail = $"SHA-256 prefix of the running game executable for server-side comparison.",
                        Evidence = $"{Path.GetFileName(gamePath)} · sha256:{hash}… · {totalBytes} modules loaded",
                    });
                }

                return (findings, (int)totalBytes);
            }
            finally { CloseHandle(hProc); }
        }
        catch (Exception ex)
        {
            findings.Add(new Finding
            {
                Id = "game-error",
                Category = "integrity",
                Severity = Severity.Low,
                Title = "Module inspection error",
                Detail = "Module inspection could not complete.",
                Evidence = ex.Message,
            });
            return (findings, 0);
        }
    }

    private static string? QueryImagePath(Process process)
    {
        try
        {
            var size = 1024;
            var sb = new StringBuilder(size);
            var h = OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, false, process.Id);
            if (h == IntPtr.Zero) return process.MainModule?.FileName;
            try
            {
                return QueryFullProcessImageName(h, 0, sb, ref size) ? sb.ToString() : process.MainModule?.FileName;
            }
            finally { CloseHandle(h); }
        }
        catch { return null; }
    }
}
