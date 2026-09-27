using System.IO;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text.Json;

namespace AntiCheatAgent.Services;

/// <summary>Runtime configuration: portal address, embedded PIN, timing.</summary>
public sealed class AppConfig
{
    public string PortalUrl { get; set; } = "http://127.0.0.1:3000";
    public string Pin { get; set; } = "";
    public string PlayerName { get; set; } = "";
    public int AutoCloseSeconds { get; set; } = 4;

    /// <summary>Minimum visible scan time (seconds) — the deep scan window.</summary>
    public int MinScanSeconds { get; set; } = 60;

    /// <summary>
    /// Unattended mode: launching with --auto counts as operator consent and the
    /// agent validates the PIN and runs the scan without UI interaction.
    /// </summary>
    public bool Auto { get; set; }

    private static string ConfigPath =>
        Path.Combine(AppContext.BaseDirectory, "agent.config.json");

    public static AppConfig Load()
    {
        var cfg = new AppConfig();
        try
        {
            if (File.Exists(ConfigPath))
            {
                var loaded = JsonSerializer.Deserialize<AppConfig>(
                    File.ReadAllText(ConfigPath),
                    new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
                if (loaded != null) cfg = loaded;
            }
        }
        catch { /* fall back to defaults */ }

        // Command line overrides: --pin ABCD-1234 --portal http://host:3000 --player "Name" --auto
        var args = Environment.GetCommandLineArgs();
        for (var i = 0; i < args.Length; i++)
        {
            if (args[i].Equals("--auto", StringComparison.OrdinalIgnoreCase)) cfg.Auto = true;
        }
        for (var i = 0; i < args.Length - 1; i++)
        {
            switch (args[i].ToLowerInvariant())
            {
                case "--pin": cfg.Pin = args[i + 1]; break;
                case "--portal": cfg.PortalUrl = args[i + 1].TrimEnd('/'); break;
                case "--player": cfg.PlayerName = args[i + 1]; break;
                case "--min-seconds":
                    if (int.TryParse(args[i + 1], out var secs)) cfg.MinScanSeconds = secs;
                    break;
            }
        }

        var envPortal = Environment.GetEnvironmentVariable("ANTICHEAT_PORTAL");
        if (!string.IsNullOrWhiteSpace(envPortal)) cfg.PortalUrl = envPortal.TrimEnd('/');

        return cfg;
    }
}

public sealed class ApiClient : IDisposable
{
    private readonly HttpClient _http;
    public string PortalUrl { get; }

    public ApiClient(string portalUrl)
    {
        PortalUrl = portalUrl.TrimEnd('/');
        _http = new HttpClient
        {
            BaseAddress = new Uri(PortalUrl),
            Timeout = TimeSpan.FromSeconds(15),
        };
        _http.DefaultRequestHeaders.UserAgent.ParseAdd("AntiCheatAgent/1.0");
    }

    public sealed record SessionInfo(string Id, string Name, string Game, string? ExpiresAt);

    public async Task<SessionInfo> ValidatePinAsync(string pin, CancellationToken ct = default)
    {
        var res = await _http.PostAsJsonAsync("/api/agent/validate", new { pin }, ct);
        var body = await res.Content.ReadFromJsonAsync<JsonElement>(ct);
        if (!res.IsSuccessStatusCode)
        {
            var error = body.TryGetProperty("error", out var e) ? e.GetString() : "Portal rejected the PIN";
            throw new InvalidOperationException(error ?? "Portal rejected the PIN");
        }

        var session = body.GetProperty("session");
        return new SessionInfo(
            session.GetProperty("id").GetString() ?? "",
            session.GetProperty("name").GetString() ?? "",
            session.GetProperty("game").GetString() ?? "Custom",
            session.TryGetProperty("expiresAt", out var ex) && ex.ValueKind != System.Text.Json.JsonValueKind.Null
                ? ex.GetString() : null);
    }

    public async Task<bool> UploadReportAsync(object report, CancellationToken ct = default)
    {
        var res = await _http.PostAsJsonAsync("/api/agent/report", report, ct);
        return res.IsSuccessStatusCode;
    }

    public void Dispose() => _http.Dispose();
}
