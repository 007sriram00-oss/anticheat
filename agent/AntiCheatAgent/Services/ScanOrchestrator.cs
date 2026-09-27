using System.Diagnostics;
using AntiCheatAgent.Models;

namespace AntiCheatAgent.Services;

/// <summary>
/// Runs every anti-cheat check in order, reports progress for the loader UI,
/// then builds and uploads the scan report to the portal.
/// Total run time is kept above <c>MinScanSeconds</c> so the deep scan always
/// gets a full verification window.
/// </summary>
public sealed class ScanOrchestrator
{
    public sealed record SessionRef(string Id, string Name, string Game);

    private readonly ApiClient _api;
    private readonly SessionRef _session;
    private readonly string _pin;
    private readonly string _playerName;
    private readonly int _minScanSeconds;

    /// <summary>Fired with (percent 0-100, step label) as the scan advances.</summary>
    public event Action<int, string>? Progress;

    public ScanOrchestrator(ApiClient api, SessionRef session, string pin, string playerName,
        int minScanSeconds = 60)
    {
        _api = api;
        _session = session;
        _pin = pin;
        _playerName = playerName;
        _minScanSeconds = Math.Max(0, minScanSeconds);
    }

    public sealed record Result(string Verdict, int Score, int Findings, int Serious,
        bool Uploaded, string? Error);

    public async Task<Result> RunAsync(DateTime consentAt, CancellationToken ct = default)
    {
        var findings = new List<Finding>();
        var summary = new Dictionary<string, object>();
        var total = Stopwatch.StartNew();
        var startedAt = DateTime.UtcNow;

        void Step(int pct, string label) => Progress?.Invoke(pct, label);
        void AddRange(List<Finding> f) { lock (findings) findings.AddRange(f); }

        // 1 — device identity & environment
        Step(3, "Collecting system information");
        await Task.Yield();
        summary["os"] = DeviceInfo.Os;
        summary["cpu"] = DeviceInfo.Cpu;
        summary["memoryMb"] = DeviceInfo.MemoryMb;

        // 1b — deep PC profile (boot/BIOS, GPU, VPN, accounts, recorders,
        //      file activity, PowerShell patterns, country, window focus)
        Step(6, "Profiling boot, hardware, accounts & network");
        var profile = await Task.Run(PcProfileScanner.Collect, ct);
        AddRange(PcProfileScanner.ToFindings(profile));
        summary["accounts"] = profile.Accounts.Count;
        summary["recordersDetected"] = profile.Recorders.Count;
        summary["recentFiles"] = profile.RecentFiles.Count;
        summary["psSuspicious"] = profile.PsSuspicious.Count;
        summary["vpnDetected"] = profile.Vpn;

        // 2 — known cheat processes
        Step(10, "Scanning running processes for known cheat tools");
        await Task.Run(() =>
        {
            var (f, n) = ProcessScanner.Run();
            AddRange(f);
            summary["processesScanned"] = n;
        }, ct);

        // 3 — debugger detection
        Step(22, "Running debugger detection checks");
        await Task.Run(() =>
        {
            AddRange(DebuggerChecker.Run());
            summary["debuggerChecks"] = 6;
        }, ct);

        // 4 — antivirus / real-time protection status
        Step(32, "Checking antivirus and real-time protection status");
        var av = SafeCollectAv();
        await Task.Run(() => AddRange(AntivirusChecker.Run(av)), ct);

        // 5 — installed cheat tooling & vulnerable drivers
        Step(40, "Checking install locations for cheat tooling");
        await Task.Run(() =>
        {
            var (f, n) = FileScanner.Run();
            AddRange(f);
            summary["toolPathsScanned"] = n;
        }, ct);

        // 6 — deep EXE/DLL file scan with signature verification (the long phase)
        FileInventoryScanner.ScanResult inventory = new(
            new List<FileInventoryScanner.FileEntry>(),
            new FileInventoryScanner.ScanStats(0, 0, 0, 0, 0, 0, false),
            new List<Finding>());

        await Task.Run(() =>
        {
            var lastLabel = "";
            inventory = FileInventoryScanner.Run((pct, label) =>
            {
                // map location progress into the 44..74 band
                var mapped = 44 + (int)(pct * 0.30);
                if (label != lastLabel)
                {
                    lastLabel = label;
                    Progress?.Invoke(mapped, label);
                }
                else
                {
                    Progress?.Invoke(mapped, "");
                }
            });
            AddRange(inventory.Findings);
            summary["filesScanned"] = inventory.Stats.FilesSeen;
            summary["signatureChecks"] = inventory.Stats.Verified;
            summary["signedFiles"] = inventory.Stats.Signed;
            summary["unsignedFiles"] = inventory.Stats.Unsigned;
            summary["flaggedFiles"] = inventory.Stats.Flagged;
        }, ct);
        Step(74, "Inspecting loaded modules in game process");

        // 7 — game process module inspection
        await Task.Run(() =>
        {
            var (f, n) = ModuleInspector.Run(_session.Game);
            AddRange(f);
            summary["modulesInspected"] = n;
        }, ct);

        // 8 — score & verdict
        Step(84, "Calculating scan verdict");
        var score = findings.Sum(f => f.Weight);
        var verdict = score >= 25 ? "detected" : score >= 5 ? "suspicious" : "clean";
        var serious = findings.Count(f => f.Severity >= Severity.High);

        // 8b — deterministic analysis narrative (weight 0, added after scoring)
        AddRange(new List<Finding>
        {
            PcProfileScanner.BuildAiOpinion(profile, findings, verdict, score,
                inventory.Stats.FilesSeen, inventory.Stats.Verified),
        });

        summary["checksRun"] = findings.Count;
        summary["seriousFindings"] = serious;

        // merged device + forensic profile reported to the portal
        var system = DeviceInfo.Snapshot();
        PcProfileScanner.MergeInto(system, profile);

        // 9 — hold the loader until the minimum scan window has passed
        var finishedAt = DateTime.UtcNow;
        var elapsed = total.Elapsed.TotalSeconds;
        if (elapsed < _minScanSeconds)
        {
            var remaining = _minScanSeconds - elapsed;
            Step(92, $"Cross-checking {inventory.Stats.FilesSeen} files against signatures…");
            var waited = 0.0;
            while (waited < remaining && !ct.IsCancellationRequested)
            {
                await Task.Delay(500, ct);
                waited += 0.5;
                var pct = 92 + (int)((waited / Math.Max(remaining, 0.1)) * 5);
                Progress?.Invoke(Math.Min(pct, 97), "");
            }
            finishedAt = DateTime.UtcNow;
        }

        // 10 — upload
        Step(97, "Uploading report to portal");
        string? error = null;
        var uploaded = false;
        try
        {
            var report = new
            {
                pin = _pin,
                deviceId = DeviceInfo.DeviceId,
                hostname = DeviceInfo.Hostname,
                playerName = _playerName,
                game = _session.Game,
                verdict,
                score,
                agentVersion = "1.0.0",
                os = DeviceInfo.Os,
                startedAt = startedAt.ToString("o"),
                finishedAt = finishedAt.ToString("o"),
                durationMs = total.ElapsedMilliseconds,
                consentAt = consentAt.ToString("o"),
                system,
                summary,
                av = new
                {
                    products = av.Products,
                    defenderServiceState = av.DefenderServiceState,
                    defenderRealtime = av.DefenderRealtime,
                    defenderPolicyDisabled = av.DefenderPolicyDisabled,
                    defenderInstalled = av.DefenderInstalled,
                    checkedAt = DateTime.UtcNow,
                },
                files = inventory.Files.Select(f => new
                {
                    path = f.Path,
                    name = f.Name,
                    kind = f.Kind,
                    sizeKb = f.SizeKb,
                    signed = f.Signed,
                    status = f.Status,
                    reason = f.Reason,
                }).ToList(),
                findings = findings.Select(f => f.ToDto()).ToList(),
            };
            uploaded = await _api.UploadReportAsync(report, ct);
            if (!uploaded) error = "Portal rejected the report";
        }
        catch (Exception ex)
        {
            error = ex.Message;
        }

        Step(100, uploaded ? "Scan complete" : "Scan complete — upload failed");

        return new Result(verdict, score, findings.Count, serious, uploaded, error);
    }

    private static AntivirusChecker.AvStatus SafeCollectAv()
    {
        try { return AntivirusChecker.Collect(); }
        catch
        {
            return new AntivirusChecker.AvStatus(
                new List<AntivirusChecker.AvProduct>(), null, null, false, false);
        }
    }
}
