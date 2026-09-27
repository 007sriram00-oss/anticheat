using System.Diagnostics;
using System.Runtime.InteropServices;
using AntiCheatAgent.Models;

namespace AntiCheatAgent.Services;

/// <summary>
/// Detects user-mode debugger presence on this process using the classic
/// Win32 / NT native checks (the same primitives anti-cheats and cheats probe).
/// </summary>
public static class DebuggerChecker
{
    private const int ProcessDebugPort = 7;
    private const int ProcessDebugFlags = 0x1F;
    private const int ProcessDebugObjectHandle = 0x1E;

    [DllImport("kernel32.dll")]
    private static extern bool IsDebuggerPresent();

    [DllImport("kernel32.dll")]
    private static extern bool CheckRemoteDebuggerPresent(IntPtr hProcess, out bool isDebuggerPresent);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(
        IntPtr processHandle,
        int processInformationClass,
        ref IntPtr processInformation,
        int processInformationLength,
        out int returnLength);

    public static List<Finding> Run()
    {
        var findings = new List<Finding>();
        var hits = new List<string>();

        try
        {
            if (Debugger.IsAttached)
                hits.Add("managed debugger attached (Debugger.IsAttached)");
        }
        catch { /* ignore */ }

        try
        {
            if (IsDebuggerPresent())
                hits.Add("IsDebuggerPresent() = TRUE");
        }
        catch { /* ignore */ }

        try
        {
            if (CheckRemoteDebuggerPresent(GetCurrentProcess(), out var remote) && remote)
                hits.Add("CheckRemoteDebuggerPresent() = TRUE");
        }
        catch { /* ignore */ }

        try
        {
            var port = IntPtr.Zero;
            var status = NtQueryInformationProcess(GetCurrentProcess(), ProcessDebugPort, ref port, IntPtr.Size, out _);
            if (status == 0 && port != IntPtr.Zero)
                hits.Add("NtQueryInformationProcess(ProcessDebugPort) != 0");
        }
        catch { /* ignore */ }

        try
        {
            var flags = IntPtr.Zero;
            var status = NtQueryInformationProcess(GetCurrentProcess(), ProcessDebugFlags, ref flags, IntPtr.Size, out _);
            // When no debugger is attached the "NoDebugInherit" flag is set to 0? -> inverted check:
            // MSDN/undocumented: returns 0 when a debugger is present (flags value == 0).
            if (status == 0 && flags == IntPtr.Zero)
                hits.Add("NtQueryInformationProcess(ProcessDebugFlags) indicates debugging");
        }
        catch { /* ignore */ }

        try
        {
            var debugObject = IntPtr.Zero;
            var status = NtQueryInformationProcess(GetCurrentProcess(), ProcessDebugObjectHandle, ref debugObject, IntPtr.Size, out _);
            if (status == 0 && debugObject != IntPtr.Zero)
            {
                hits.Add("NtQueryInformationProcess(ProcessDebugObjectHandle) returned a handle");
                CloseHandle(debugObject);
            }
        }
        catch { /* ignore */ }

        if (hits.Count > 0)
        {
            findings.Add(new Finding
            {
                Id = "dbg-present",
                Category = "debugger",
                Severity = Severity.Medium,
                Title = "Debugger detected on anti-cheat process",
                Detail = "One or more debugger detection primitives report an active debugger attached to the agent. " +
                         "In a tournament setting the agent must run without a debugger attached.",
                Evidence = string.Join("; ", hits),
            });
        }
        else
        {
            findings.Add(new Finding
            {
                Id = "dbg-clean",
                Category = "debugger",
                Severity = Severity.Info,
                Title = "No debugger attached",
                Detail = "All 6 debugger detection primitives (IsDebuggerPresent, CheckRemoteDebuggerPresent, " +
                         "ProcessDebugPort, ProcessDebugFlags, ProcessDebugObjectHandle, managed attach) reported clean.",
                Evidence = "",
            });
        }

        return findings;
    }
}
