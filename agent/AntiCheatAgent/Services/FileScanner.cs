using System.IO;
using AntiCheatAgent.Models;

namespace AntiCheatAgent.Services;

/// <summary>
/// Scans standard install locations for known cheat tooling folders and
/// known cheat-abuse drivers in the Windows drivers directory.
/// Only well-known public tool names are searched — no arbitrary file inventory.
/// </summary>
public static class FileScanner
{
    public static (List<Finding> Findings, int Scanned) Run()
    {
        var findings = new List<Finding>();
        var scanned = 0;

        // 1) Standard program locations for known cheat / RE tool folders.
        var roots = new[]
        {
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs"),
        };

        foreach (var root in roots.Where(r => !string.IsNullOrEmpty(r) && Directory.Exists(r)))
        {
            foreach (var folder in KnownCheatDb.SuspiciousFolderNames)
            {
                scanned++;
                var candidate = Path.Combine(root, folder);
                if (!Directory.Exists(candidate)) continue;

                findings.Add(new Finding
                {
                    Id = $"file-{folder}-{root.GetHashCode():x8}",
                    Category = "tool",
                    Severity = Severity.High,
                    Title = "Cheat/debug tool installed",
                    Detail = $"A directory matching a known cheat or reverse-engineering tool is present in a " +
                             $"standard install location ({root}).",
                    Evidence = candidate,
                });
            }
        }

        // 2) Cheat-abuse drivers in %SystemRoot%\System32\drivers.
        var driversDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "System32", "drivers");
        if (Directory.Exists(driversDir))
        {
            foreach (var driver in KnownCheatDb.SuspiciousDrivers)
            {
                scanned++;
                var candidate = Path.Combine(driversDir, driver);
                if (!File.Exists(candidate)) continue;

                findings.Add(new Finding
                {
                    Id = $"driver-{driver}",
                    Category = "driver",
                    Severity = Severity.High,
                    Title = "Vulnerable / cheat-abuse driver present",
                    Detail = $"{driver} is a driver with a documented history of abuse for raw memory access " +
                             $"by cheats (BYOVD-style). Its presence warrants review.",
                    Evidence = candidate,
                });
            }
        }

        if (findings.Count == 0)
        {
            findings.Add(new Finding
            {
                Id = "file-clean",
                Category = "tool",
                Severity = Severity.Info,
                Title = "No known cheat tooling found in install locations",
                Detail = $"Scanned {scanned} standard locations for known cheat tool folders and cheat-abuse drivers. " +
                         "Nothing matched.",
                Evidence = "",
            });
        }

        return (findings, scanned);
    }
}
