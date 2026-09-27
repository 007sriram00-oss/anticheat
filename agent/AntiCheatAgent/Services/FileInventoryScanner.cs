using System.IO;
using System.Runtime.InteropServices;
using AntiCheatAgent.Models;

namespace AntiCheatAgent.Services;

/// <summary>
/// Deep scan of executable locations for EXE/DLL files. Verifies Authenticode
/// signatures (WinVerifyTrust), flags known cheat binaries, unsigned executables
/// and executables dropped in temp/appdata locations.
/// </summary>
public static partial class FileInventoryScanner
{
    public const int MaxFlagged = 400;       // cap for per-file report entries
    public const int MaxVerifications = 6000; // cap for signature checks per run

    public sealed record FileEntry(
        string Path,
        string Name,
        string Kind,       // exe | dll | sys | other
        long SizeKb,
        bool? Signed,      // null = not verified
        string Status,     // detected | suspicious | unsigned | ok
        string Reason);

    public sealed record ScanStats(
        int Locations,
        int FilesSeen,
        int Verified,
        int Signed,
        int Unsigned,
        int Flagged,
        bool Truncated);

    public sealed record ScanResult(
        List<FileEntry> Files,
        ScanStats Stats,
        List<Finding> Findings);

    /* -------------------------------------------------- WinVerifyTrust */

    private const int WtdUiNone = 2;
    private const int WtdChoiceFile = 1;
    private const int WtdStateActionVerify = 1;
    private const int WtdStateActionClose = 2;
    private const int WtdRevokeNone = 0;
    private const int WtdCacheOnlyUrlRetrieval = 0x00000010;

    /// <summary>Exact x64/x86 layout of WINTRUST_FILE_INFO (wintrust.h).</summary>
    [StructLayout(LayoutKind.Sequential)]
    private struct WinTrustFileInfo
    {
        public int StructSize;
        public IntPtr FilePath;      // LPCWSTR pcwszFilePath
        public IntPtr hFile;         // HANDLE hFile
        public IntPtr KnownSubject;  // GUID *pgKnownSubject
    }

    /// <summary>Exact layout of WINTRUST_DATA (wintrust.h) — field order is critical.</summary>
    [StructLayout(LayoutKind.Sequential)]
    private struct WinTrustData
    {
        public int StructSize;          // cbStruct
        public IntPtr PolicyCallback;   // pPolicyCallbackData
        public IntPtr SipClientData;    // pSIPClientData
        public int UiChoice;            // dwUIChoice
        public int RevocationChecks;    // fdwRevocationChecks
        public int UnionChoice;         // dwUnionChoice
        public IntPtr FileInfo;         // union: WINTRUST_FILE_INFO *pFile
        public int StateAction;         // dwStateAction
        public IntPtr StateData;        // hWVTStateData
        public IntPtr UrlReference;     // wszURLReference
        public int ProvFlags;           // dwProvFlags
        public int UiContext;           // dwUIContext
    }

    private static readonly Guid WtdActionGenericVerifyV2 = new("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");

    [DllImport("wintrust.dll", ExactSpelling = true, SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern uint WinVerifyTrust(IntPtr hwnd, ref Guid pgActionName, ref WinTrustData pWvtData);

    /// <summary>Returns true when the embedded signature is trusted.</summary>
    private static bool IsSignatureTrusted(string path, out uint resultCode)
    {
        resultCode = 0;
        var fileInfo = new WinTrustFileInfo
        {
            StructSize = Marshal.SizeOf<WinTrustFileInfo>(),
            FilePath = Marshal.StringToHGlobalUni(path),
        };
        var fileInfoPtr = Marshal.AllocHGlobal(fileInfo.StructSize);
        try
        {
            Marshal.StructureToPtr(fileInfo, fileInfoPtr, false);

            var data = new WinTrustData
            {
                StructSize = Marshal.SizeOf<WinTrustData>(),
                PolicyCallback = IntPtr.Zero,
                SipClientData = IntPtr.Zero,
                UiChoice = WtdUiNone,
                RevocationChecks = WtdRevokeNone,
                UnionChoice = WtdChoiceFile,
                FileInfo = fileInfoPtr,
                StateAction = WtdStateActionVerify,
                StateData = IntPtr.Zero,
                UrlReference = IntPtr.Zero,
                ProvFlags = WtdCacheOnlyUrlRetrieval,
                UiContext = 0,
            };

            var guid = WtdActionGenericVerifyV2;
            resultCode = WinVerifyTrust(IntPtr.Zero, ref guid, ref data);
            return resultCode == 0;
        }
        catch
        {
            return false;
        }
        finally
        {
            // release the WVT state handle
            try
            {
                var data = new WinTrustData
                {
                    StructSize = Marshal.SizeOf<WinTrustData>(),
                    UnionChoice = WtdChoiceFile,
                    FileInfo = fileInfoPtr,
                    StateAction = WtdStateActionClose,
                };
                var guid = WtdActionGenericVerifyV2;
                WinVerifyTrust(IntPtr.Zero, ref guid, ref data);
            }
            catch { /* ignore */ }

            Marshal.FreeHGlobal(fileInfoPtr);
            if (fileInfo.FilePath != IntPtr.Zero) Marshal.FreeHGlobal(fileInfo.FilePath);
        }
    }

    private static bool IsSigned(string path) => IsSignatureTrusted(path, out _);

    /* ------------------------------------------------------- scan */

    private static readonly string[] CheatExeNames =
    {
        "cheatengine.exe", "cheatengine-x86_64.exe", "cheatengine-i386.exe", "ce-x86_64.exe",
        "x64dbg.exe", "x32dbg.exe", "ollydbg.exe", "scylla.exe", "scylla_x64.exe",
        "processhacker.exe", "systeminformer.exe", "frida-server.exe", "artmoney.exe",
        "tsearch.exe", "memeditor.exe", "apimonitor-x64.exe", "apimonitor-x86.exe",
    };

    private static readonly string[] CheatDllNames =
    {
        "cheatengine-x86_64.dll", "cheatengine-i386.dll", "cheatengine.dll",
        "speedhack.dll", "frida-agent-64.dll", "frida-agent-32.dll", "easyinjector.dll",
    };

    public static ScanResult Run(Action<int, string>? progress = null)
    {
        var findings = new List<Finding>();
        var files = new List<FileEntry>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        var locations = BuildLocations();
        var (filesSeen, verified, signedCount, unsignedCount) = (0, 0, 0, 0);
        var truncated = false;
        var locationsScanned = 0;

        void Flag(FileEntry e)
        {
            if (files.Count < MaxFlagged) files.Add(e);
            else truncated = true;
        }

        var user = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);

        foreach (var (label, dir, deep) in locations)
        {
            if (!Directory.Exists(dir)) continue;
            locationsScanned++;

            foreach (var path in SafeEnumerate(dir, deep))
            {
                if (filesSeen >= MaxVerifications * 4) { truncated = true; break; }

                var ext = Path.GetExtension(path).ToLowerInvariant();
                if (ext is not (".exe" or ".dll" or ".sys" or ".scr")) continue;
                filesSeen++;
                if (!seen.Add(path)) continue;

                var name = Path.GetFileName(path);
                var kind = ext == ".exe" || ext == ".scr" ? "exe" : ext == ".dll" ? "dll" : ext == ".sys" ? "sys" : "other";

                long sizeKb = 0;
                try { sizeKb = new FileInfo(path).Length / 1024; } catch { }

                // --- known cheat binaries => detected (critical)
                var isCheat = CheatExeNames.Contains(name, StringComparer.OrdinalIgnoreCase) ||
                              CheatDllNames.Contains(name, StringComparer.OrdinalIgnoreCase) ||
                              KnownCheatDb.SuspiciousFolderNames.Contains(
                                  Path.GetFileName(Path.GetDirectoryName(path) ?? ""), StringComparer.OrdinalIgnoreCase);

                if (isCheat)
                {
                    Flag(new FileEntry(path, name, kind, sizeKb, null, "detected",
                        "File name matches a known cheat / reverse-engineering tool"));
                    continue;
                }

                // --- executables in temp / appdata drop locations => suspicious
                var inTemp = path.StartsWith(Path.GetTempPath(), StringComparison.OrdinalIgnoreCase) ||
                             path.Contains(@"\Windows\Temp\", StringComparison.OrdinalIgnoreCase);
                var inAppData = path.StartsWith(
                    Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), StringComparison.OrdinalIgnoreCase) ||
                    path.StartsWith(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), StringComparison.OrdinalIgnoreCase);
                var inDownloads = path.StartsWith(Path.Combine(user, "Downloads"), StringComparison.OrdinalIgnoreCase);

                if (inTemp && kind == "exe")
                {
                    Flag(new FileEntry(path, name, kind, sizeKb, null, "suspicious",
                        "Executable located in a temp folder - malware/cheats commonly run from here"));
                    continue;
                }

                // --- signature verification (bounded)
                bool? signed = null;
                if (verified < MaxVerifications)
                {
                    signed = IsSigned(path);
                    verified++;
                    if (signed == true) signedCount++; else unsignedCount++;
                }

                if (signed == false && kind == "exe" && (inAppData || inDownloads))
                {
                    Flag(new FileEntry(path, name, kind, sizeKb, false, "unsigned",
                        inDownloads
                            ? "Unsigned executable in Downloads - not verified against any publisher"
                            : "Unsigned executable in AppData - suspicious persistence location"));
                }
                else if (signed == false && kind == "dll" && inAppData)
                {
                    Flag(new FileEntry(path, name, kind, sizeKb, false, "unsigned",
                        "Unsigned DLL in AppData - possible injected/add-on library"));
                }

                
            }

            progress?.Invoke(
                Math.Min(96, locationsScanned * 100 / Math.Max(locations.Count, 1)),
                $"Scanning {label}...");
            if (truncated) break;
        }

        // Aggregate findings per bucket (one finding per category, evidence lists files).
        void AddBucket(string id, string title, string detail, Severity sev, string category, IEnumerable<FileEntry> bucket)
        {
            var list = bucket.Take(10).ToList();
            if (list.Count == 0) return;
            var total = bucket.Count();
            findings.Add(new Finding
            {
                Id = id,
                Category = category,
                Severity = sev,
                Title = total > list.Count ? $"{title} ({total} files)" : title,
                Detail = detail,
                Evidence = string.Join("\n", list.Select(f => f.Path)) +
                           (total > list.Count ? $"\n(+{total - list.Count} more in report)" : ""),
            });
        }

        AddBucket("file-cheat", "Known cheat executable found on disk",
            "A file whose name matches a known cheat tool was found in a scanned location.",
            Severity.Critical, "exe",
            files.Where(f => f.Status == "detected" && f.Kind == "exe"));

        AddBucket("file-cheat-dll", "Known cheat DLL found on disk",
            "A DLL matching known cheat/injection libraries is present on disk.",
            Severity.Critical, "dll",
            files.Where(f => f.Status == "detected" && f.Kind == "dll"));

        AddBucket("file-temp", "Executables in temp folders",
            "EXE files sitting in temp folders are a common signature of cheat installers and droppers.",
            Severity.High, "exe",
            files.Where(f => f.Status == "suspicious"));

        AddBucket("file-unsigned-exe", "Unsigned executables in user folders",
            "Executable files in Downloads/AppData without a trusted publisher signature. " +
            "Legitimate software is normally signed - review these.",
            Severity.Medium, "exe",
            files.Where(f => f.Status == "unsigned" && f.Kind == "exe"));

        AddBucket("file-unsigned-dll", "Unsigned DLLs in user folders",
            "DLL files in AppData without a trusted signature - these can be injected into the game.",
            Severity.Medium, "dll",
            files.Where(f => f.Status == "unsigned" && f.Kind == "dll"));

        var flagged = files.Count(f => f.Status != "ok");
        if (flagged == 0)
        {
            findings.Add(new Finding
            {
                Id = "file-clean",
                Category = "files",
                Severity = Severity.Info,
                Title = "No unauthorized executables found",
                Detail = $"Scanned {filesSeen} files across {locationsScanned} executable locations " +
                         $"({verified} signature checks: {signedCount} signed, {unsignedCount} unsigned). " +
                         "No cheat binaries, temp-droppers or unsigned user executables were found.",
                Evidence = "Locations: " + string.Join(", ", locations.Select(l => l.Label)),
            });
        }
        else
        {
            findings.Add(new Finding
            {
                Id = "file-summary",
                Category = "files",
                Severity = Severity.Info,
                Title = "File scan summary",
                Detail = $"Scanned {filesSeen} files across {locationsScanned} locations - {verified} signature " +
                         $"checks ({signedCount} signed / {unsignedCount} unsigned), {flagged} flagged for review.",
                Evidence = "Locations: " + string.Join(", ", locations.Select(l => l.Label)),
            });
        }

        // Keep only flagged entries plus a hard cap for the report payload.
        var reportFiles = files
            .OrderBy(f => f.Status switch { "detected" => 0, "suspicious" => 1, "unsigned" => 2, _ => 3 })
            .Take(MaxFlagged)
            .ToList();

        return new ScanResult(
            reportFiles,
            new ScanStats(locationsScanned, filesSeen, verified, signedCount, unsignedCount, flagged, truncated),
            findings);
    }

    /// <summary>
    /// Directory walker that survives access-denied folders and skips
    /// reparse points (junctions) so it cannot loop forever.
    /// </summary>
    private static IEnumerable<string> SafeEnumerate(string root, bool deep)
    {
        var pending = new Stack<(string Path, int Depth)>();
        pending.Push((root, 0));
        var maxDepth = deep ? 12 : 1;

        while (pending.Count > 0)
        {
            var (dir, depth) = pending.Pop();

            string[] files;
            try { files = Directory.GetFiles(dir); }
            catch { files = Array.Empty<string>(); }
            foreach (var f in files) yield return f;

            if (depth >= maxDepth) continue;

            string[] dirs;
            try { dirs = Directory.GetDirectories(dir); }
            catch { dirs = Array.Empty<string>(); }
            foreach (var sub in dirs)
            {
                try
                {
                    if ((File.GetAttributes(sub) & FileAttributes.ReparsePoint) != 0) continue;
                }
                catch { continue; }
                pending.Push((sub, depth + 1));
            }
        }
    }

    private static List<(string Label, string Path, bool Deep)> BuildLocations()
    {
        var user = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var locations = new List<(string, string, bool)>
        {
            ("Downloads", Path.Combine(user, "Downloads"), true),
            ("User temp", Path.GetTempPath(), true),
            ("Windows temp", Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "Temp"), true),
            ("Program Files", Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), true),
            ("Program Files (x86)", Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), true),
            ("AppData\\Roaming", Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), false),
            ("AppData\\Local", Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), false),
            ("Public folders", Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), false),
        };
        return locations.Where(l => !string.IsNullOrEmpty(l.Item2)).ToList();
    }
}
