using System.Management;
using System.Runtime.InteropServices;
using Microsoft.Win32;
using AntiCheatAgent.Models;

namespace AntiCheatAgent.Services;

/// <summary>
/// Checks whether antivirus / real-time protection is installed and running.
/// Sources: WMI SecurityCenter2 (AV products), Windows Defender service state,
/// and policy registry keys that disable Defender.
/// </summary>
public static class AntivirusChecker
{
    public sealed record AvProduct(string Name, bool Enabled, bool UpToDate, string StateHex);

    public sealed record AvStatus(
        List<AvProduct> Products,
        string? DefenderServiceState,
        bool? DefenderRealtime,
        bool DefenderPolicyDisabled,
        bool DefenderInstalled);

    public static AvStatus Collect()
    {
        var products = new List<AvProduct>();

        // 1) AV products registered with the Windows Security Center.
        try
        {
            using var searcher = new ManagementObjectSearcher(
                @"root\SecurityCenter2",
                "SELECT displayName, productState FROM AntiVirusProduct");
            foreach (ManagementObject obj in searcher.Get())
            {
                var name = obj["displayName"]?.ToString() ?? "Unknown AV";
                var state = Convert.ToUInt32(obj["productState"] ?? 0u);

                // productState decoding (bit flags published by Microsoft):
                //   0x1000  -> real-time protection enabled
                //   0x0010  -> definitions out of date
                var enabled = (state & 0x1000) != 0;
                var upToDate = (state & 0x0010) == 0;
                products.Add(new AvProduct(name, enabled, upToDate, $"0x{state:X6}"));
            }
        }
        catch { /* SecurityCenter2 unavailable (Server SKUs / service off) */ }

        // 2) Windows Defender service state.
        string? serviceState = null;
        try
        {
            using var searcher = new ManagementObjectSearcher(
                @"root\CIMV2", "SELECT Name, State FROM Win32_Service WHERE Name = 'WinDefend'");
            foreach (ManagementObject obj in searcher.Get())
                serviceState = obj["State"]?.ToString() ?? "Unknown";
        }
        catch { /* WMI unavailable */ }

        // 3) Defender policy keys used to switch Defender off.
        var policyDisabled = false;
        try
        {
            var key = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Policies\Microsoft\Windows Defender");
            var disableSpyware = key?.GetValue("DisableAntiSpyware");
            var disableVirus = key?.GetValue("DisableAntiVirus");
            policyDisabled =
                (disableSpyware is int d1 && d1 == 1) ||
                (disableVirus is int d2 && d2 == 1);
        }
        catch { /* access denied */ }

        // 4) Real-time protection toggle (often admin-only; null when unreadable).
        bool? realtime = null;
        try
        {
            var key = Registry.LocalMachine.OpenSubKey(
                @"SOFTWARE\Microsoft\Windows Defender\Real-Time Protection");
            var val = key?.GetValue("DisableRealtimeMonitoring");
            if (val is int r) realtime = r != 1;
        }
        catch { /* access denied */ }

        // 5) Is Defender itself installed (always true on Win10/11 home/pro).
        var defenderInstalled = false;
        try
        {
            using var k = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows Defender");
            defenderInstalled = k != null;
        }
        catch { }

        return new AvStatus(products, serviceState, realtime, policyDisabled, defenderInstalled);
    }

    public static List<Finding> Run(AvStatus? statusIn = null)
    {
        var findings = new List<Finding>();
        var status = statusIn is null ? Collect() : statusIn;
        var enabled = status.Products.Where(p => p.Enabled).ToList();
        var disabled = status.Products.Where(p => !p.Enabled).ToList();
        var evidence = string.Join("\n", status.Products.Select(p =>
            $"{p.Name} — {(p.Enabled ? "enabled" : "DISABLED")}, {(p.UpToDate ? "definitions up to date" : "definitions OUT OF DATE")}, state {p.StateHex}"));

        // Product that is registered but switched off.
        foreach (var p in disabled)
        {
            findings.Add(new Finding
            {
                Id = $"av-off-{p.Name.GetHashCode():x8}",
                Category = "antivirus",
                Severity = Severity.Critical,
                Title = $"Antivirus disabled: {p.Name}",
                Detail = "An antivirus product is installed but its real-time protection is switched off. " +
                         "Tournament rules require antivirus to stay enabled during play.",
                Evidence = evidence,
            });
        }

        if (status.DefenderPolicyDisabled)
        {
            findings.Add(new Finding
            {
                Id = "av-policy",
                Category = "antivirus",
                Severity = Severity.Critical,
                Title = "Windows Defender disabled by group policy",
                Detail = "Registry policy keys DisableAntiSpyware/DisableAntiVirus are set — Defender has been " +
                         "switched off through policy, which is a common anti-detection step.",
                Evidence = @"HKLM\SOFTWARE\Policies\Microsoft\Windows Defender (DisableAntiSpyware / DisableAntiVirus = 1)",
            });
        }

        if (status.DefenderRealtime == false)
        {
            findings.Add(new Finding
            {
                Id = "av-realtime",
                Category = "antivirus",
                Severity = Severity.Critical,
                Title = "Windows Defender real-time protection is off",
                Detail = "DisableRealtimeMonitoring = 1 — file real-time scanning has been switched off on this PC.",
                Evidence = @"HKLM\SOFTWARE\Microsoft\Windows Defender\Real-Time Protection\DisableRealtimeMonitoring = 1",
            });
        }

        if (status.DefenderServiceState != null &&
            !status.DefenderServiceState.Equals("Running", StringComparison.OrdinalIgnoreCase) &&
            enabled.Count == 0)
        {
            findings.Add(new Finding
            {
                Id = "av-service",
                Category = "antivirus",
                Severity = Severity.High,
                Title = "No antivirus service is running",
                Detail = $"The Windows Defender service (WinDefend) reports '{status.DefenderServiceState}' and no " +
                         "other antivirus product is enabled on this PC.",
                Evidence = $"WinDefend state: {status.DefenderServiceState}",
            });
        }

        if (status.Products.Count == 0)
        {
            findings.Add(new Finding
            {
                Id = "av-none",
                Category = "antivirus",
                Severity = Severity.High,
                Title = "No antivirus reported to Windows Security Center",
                Detail = "No antivirus product is registered with the Security Center. Either no AV is installed or " +
                         "the Security Center service has been disabled.",
                Evidence = $"WinDefend: {status.DefenderServiceState ?? "unknown"}",
            });
        }
        else if (enabled.Count > 0 && disabled.Count == 0 &&
                 !status.DefenderPolicyDisabled && status.DefenderRealtime != false)
        {
            var outdated = enabled.Where(p => !p.UpToDate).ToList();
            findings.Add(new Finding
            {
                Id = "av-ok",
                Category = "antivirus",
                Severity = outdated.Count > 0 ? Severity.Low : Severity.Info,
                Title = outdated.Count > 0
                    ? $"Antivirus active but definitions outdated ({outdated.Count})"
                    : "Antivirus active with real-time protection",
                Detail = outdated.Count > 0
                    ? "Protection is on, but virus definitions are out of date."
                    : "At least one antivirus product is registered and enabled.",
                Evidence = evidence,
            });
        }

        return findings;
    }
}
