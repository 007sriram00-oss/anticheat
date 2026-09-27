using System.Diagnostics;
using AntiCheatAgent.Models;

namespace AntiCheatAgent.Services;

/// <summary>
/// Enumerates running processes and matches them against known cheat / debug tool names.
/// </summary>
public static class ProcessScanner
{
    public static (List<Finding> Findings, int Scanned) Run()
    {
        var findings = new List<Finding>();
        Process[] processes;
        try
        {
            processes = Process.GetProcesses();
        }
        catch (Exception ex)
        {
            return (new List<Finding>
            {
                new()
                {
                    Id = "proc-error",
                    Category = "process",
                    Severity = Severity.Low,
                    Title = "Process enumeration failed",
                    Detail = "The process list could not be read.",
                    Evidence = ex.Message,
                },
            }, 0);
        }

        var hits = new List<(string Name, int Pid, string Title, string Severity, string Category)>();
        var emulators = new List<string>();

        foreach (var proc in processes)
        {
            using (proc)
            {
                string name;
                try { name = proc.ProcessName; }
                catch { continue; } // process exited or access denied

                if (KnownCheatDb.SuspiciousProcesses.TryGetValue(name, out var meta))
                {
                    int pid;
                    try { pid = proc.Id; } catch { pid = -1; }
                    hits.Add((name, pid, meta.Title, meta.Severity, meta.Category));
                }
                else if (name.Contains("cheatengine", StringComparison.OrdinalIgnoreCase) ||
                         name.Contains("cheat engine", StringComparison.OrdinalIgnoreCase))
                {
                    int pid;
                    try { pid = proc.Id; } catch { pid = -1; }
                    hits.Add((name, pid, "Cheat Engine variant detected", "critical", "process"));
                }

                if (KnownCheatDb.EmulatorProcesses.Contains(name, StringComparer.OrdinalIgnoreCase))
                    emulators.Add(name);
            }
        }

        foreach (var hit in hits)
        {
            findings.Add(new Finding
            {
                Id = $"proc-{hit.Name}-{hit.Pid}",
                Category = hit.Category,
                Severity = ParseSeverity(hit.Severity),
                Title = hit.Title,
                Detail = $"A process matching a known cheat/debug tool signature is running ({hit.Name}).",
                Evidence = $"{hit.Name}.exe (PID {hit.Pid})",
            });
        }

        if (emulators.Count > 0)
        {
            findings.Add(new Finding
            {
                Id = "proc-emulator",
                Category = "environment",
                Severity = Severity.Info,
                Title = "Game emulator environment detected",
                Detail = "The game appears to run inside an emulator on this PC. Emulators are common for mobile " +
                         "esports titles; module inspection also covers the emulator host process.",
                Evidence = string.Join(", ", emulators.Distinct()),
            });
        }

        return (findings, processes.Length);
    }

    public static Severity ParseSeverity(string text) => text.ToLowerInvariant() switch
    {
        "critical" => Severity.Critical,
        "high" => Severity.High,
        "medium" => Severity.Medium,
        "low" => Severity.Low,
        _ => Severity.Info,
    };
}
