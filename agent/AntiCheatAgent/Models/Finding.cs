namespace AntiCheatAgent.Models;

/// <summary>Severity levels for scan findings (aligned with portal display).</summary>
public enum Severity
{
    Info,
    Low,
    Medium,
    High,
    Critical,
}

/// <summary>A single result produced by one anti-cheat check.</summary>
public sealed class Finding
{
    public required string Id { get; init; }
    public required string Category { get; init; }
    public required Severity Severity { get; init; }
    public required string Title { get; init; }
    public required string Detail { get; init; }
    public string Evidence { get; init; } = "";

    /// <summary>Tab category used by the portal report UI (exe, dll, process, antivirus…).</summary>
    public string Kind { get; init; } = "";

    public string KindText => !string.IsNullOrEmpty(Kind) ? Kind : Category switch
    {
        "process" or "environment" => "process",
        "debugger" => "debugger",
        "injection" => "dll",
        "tool" or "driver" => "tool",
        "integrity" => "integrity",
        "antivirus" => "antivirus",
        "exe" => "exe",
        "dll" => "dll",
        "files" => "files",
        _ => "checks",
    };

    public string SeverityText => Severity.ToString().ToLowerInvariant();

    public int Weight => Severity switch
    {
        Severity.Critical => 25,
        Severity.High => 12,
        Severity.Medium => 5,
        Severity.Low => 1,
        _ => 0,
    };

    public Dictionary<string, object> ToDto() => new()
    {
        ["id"] = Id,
        ["category"] = Category,
        ["kind"] = KindText,
        ["severity"] = SeverityText,
        ["title"] = Title,
        ["detail"] = Detail,
        ["evidence"] = Evidence,
    };
}
