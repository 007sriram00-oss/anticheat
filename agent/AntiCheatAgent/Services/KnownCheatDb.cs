namespace AntiCheatAgent.Services;

/// <summary>
/// Curated signatures of well-known cheat/debug tooling and game process names.
/// All entries are publicly documented tool names — no third-party data is used.
/// </summary>
public static class KnownCheatDb
{
    /// <summary>process name (no extension) → (title, severity as text, category)</summary>
    public static readonly IReadOnlyDictionary<string, (string Title, string Severity, string Category)> SuspiciousProcesses =
        new Dictionary<string, (string, string, string)>(StringComparer.OrdinalIgnoreCase)
        {
            // cheat engines
            ["cheatengine"]            = ("Cheat Engine process detected", "critical", "process"),
            ["cheatengine-x86_64"]     = ("Cheat Engine process detected", "critical", "process"),
            ["cheatengine-i386"]       = ("Cheat Engine process detected", "critical", "process"),
            ["ce-x86_64"]              = ("Cheat Engine component detected", "critical", "process"),
            // debuggers / reverse engineering
            ["x64dbg"]                 = ("x64dbg debugger detected", "high", "debugger"),
            ["x32dbg"]                 = ("x32dbg debugger detected", "high", "debugger"),
            ["ollydbg"]                = ("OllyDbg debugger detected", "high", "debugger"),
            ["windbg"]                 = ("WinDbg debugger detected", "medium", "debugger"),
            ["ida64"]                  = ("IDA disassembler detected", "medium", "debugger"),
            ["ida"]                    = ("IDA disassembler detected", "medium", "debugger"),
            ["ghidraRun"]              = ("Ghidra disassembler detected", "medium", "debugger"),
            ["scylla"]                 = ("Scylla unpacker detected", "high", "debugger"),
            ["scylla_x64"]             = ("Scylla unpacker detected", "high", "debugger"),
            ["dnspy"]                  = ("dnSpy .NET disassembler detected", "medium", "debugger"),
            // process/memory inspection
            ["processhacker"]          = ("Process Hacker detected", "medium", "tool"),
            ["systeminformer"]         = ("System Informer detected", "medium", "tool"),
            ["processmonitor"]         = ("Process Monitor detected", "low", "tool"),
            ["procmon"]                = ("Process Monitor detected", "low", "tool"),
            ["procmon64"]              = ("Process Monitor detected", "low", "tool"),
            ["api-monitor"]            = ("API Monitor detected", "medium", "tool"),
            ["apimonitor-x64"]         = ("API Monitor detected", "medium", "tool"),
            // injection / hooking helpers frequently abused by cheats
            ["frida-server"]           = ("Frida instrumentation server detected", "high", "injection"),
            ["injector"]               = ("Generic DLL injector process detected", "critical", "injection"),
            ["dllinjector"]            = ("DLL injector process detected", "critical", "injection"),
            ["memeditor"]              = ("Memory editor process detected", "critical", "injection"),
            ["artmoney"]               = ("ArtMoney memory editor detected", "critical", "injection"),
            ["tsearch"]                = ("TSearch memory editor detected", "critical", "injection"),
        };

    /// <summary>Folder names in standard install locations that indicate cheat tooling.</summary>
    public static readonly string[] SuspiciousFolderNames =
    {
        "Cheat Engine",
        "x64dbg",
        "x32dbg",
        "OllyDbg",
        "Process Hacker",
        "System Informer",
        "ReClass.NET",
        "Scylla",
        "API Monitor",
    };

    /// <summary>Injected module / DLL names that are strong cheat indicators.</summary>
    public static readonly string[] SuspiciousModuleNames =
    {
        "cheatengine-x86_64.dll",
        "cheatengine-i386.dll",
        "cheatengine.dll",
        "speedhack.dll",
        "frida-agent-64.dll",
        "frida-agent-32.dll",
        "detours.dll",
        "easyinjector.dll",
    };

    /// <summary>Vulnerable / cheat-abuse driver files sometimes dropped in system32\drivers.</summary>
    public static readonly string[] SuspiciousDrivers =
    {
        "winio64.sys",
        "winio32.sys",
        "winring0.sys",
        "physmemdrv.sys",
        "kprocesshacker.sys",
        "iomap64.sys",
    };

    /// <summary>Game title → process names to inspect for injected modules.</summary>
    public static readonly IReadOnlyDictionary<string, string[]> GameProcesses =
        new Dictionary<string, string[]>(StringComparer.OrdinalIgnoreCase)
        {
            ["Free Fire"]     = new[] { "FreeFire", "com.dts.freefireth", "Garena", "HD-Player", "BlueStacks" },
            ["PUBG Mobile"]   = new[] { "TslGame", "ShadowTrackerExtra", "ProjectA", "HD-Player" },
            ["BGMI"]          = new[] { "ShadowTrackerExtra", "TslGame", "Battlegrounds" },
            ["PUBG PC"]       = new[] { "TslGame" },
            ["Valorant"]      = new[] { "VALORANT-Win64-Shipping", "RiotClientServices" },
            ["COD Mobile"]    = new[] { "com.activision.callofduty.shooter", "HD-Player" },
            ["Fortnite"]      = new[] { "FortniteClient-Win64-Shipping", "FortniteLauncher" },
            ["Custom"]        = Array.Empty<string>(),
        };

    /// <summary>Process names commonly hosting mobile games on PC (emulators).</summary>
    public static readonly string[] EmulatorProcesses =
    {
        "HD-Player", "BlueStacks", "LdVBoxHeadless", "dnplayer", "MEmu", "Nox", "qemu-system-x86_64",
    };
}
