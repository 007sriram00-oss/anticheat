using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32;

namespace AntiCheatAgent.Services;

/// <summary>Basic, non-invasive device identity for the report header.</summary>
public static class DeviceInfo
{
    [StructLayout(LayoutKind.Sequential)]
    private class MemoryStatus
    {
        public uint Length;
        public uint MemoryLoad;
        public ulong TotalPhys;
        public ulong AvailPhys;
        public ulong TotalPageFile;
        public ulong AvailPageFile;
        public ulong TotalVirtual;
        public ulong AvailVirtual;
        public ulong AvailExtendedVirtual;
    }

    [DllImport("kernel32.dll")]
    private static extern bool GlobalMemoryStatusEx(MemoryStatus lpBuffer);

    public static string Hostname
    {
        get
        {
            try { return Environment.MachineName; }
            catch { return "unknown"; }
        }
    }

    public static string Os
    {
        get
        {
            try
            {
                var desc = RuntimeInformation.OSDescription.Trim();
                var arch = RuntimeInformation.OSArchitecture.ToString().ToLowerInvariant();
                return $"{desc} ({arch})";
            }
            catch { return "Windows"; }
        }
    }

    public static string Cpu
    {
        get
        {
            try
            {
                return Registry.GetValue(
                        @"HKEY_LOCAL_MACHINE\HARDWARE\DESCRIPTION\System\CentralProcessor\0",
                        "ProcessorNameString", "") as string ?? "Unknown CPU";
            }
            catch { return "Unknown CPU"; }
        }
    }

    public static ulong MemoryMb
    {
        get
        {
            try
            {
                var status = new MemoryStatus { Length = (uint)Marshal.SizeOf<MemoryStatus>() };
                return GlobalMemoryStatusEx(status) ? status.TotalPhys / (1024 * 1024) : 0;
            }
            catch { return 0; }
        }
    }

    public static double UptimeMinutes
    {
        get
        {
            try { return TimeSpan.FromMilliseconds(Environment.TickCount64).TotalMinutes; }
            catch { return 0; }
        }
    }

    /// <summary>Stable pseudo-anonymous device id: hash of machine GUID + user.</summary>
    public static string DeviceId
    {
        get
        {
            try
            {
                var machineGuid = Registry.GetValue(
                        @"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Cryptography", "MachineGuid", "") as string ?? "";
                var raw = $"{machineGuid}|{Environment.UserName}|{Environment.ProcessorCount}";
                var hash = SHA256.HashData(Encoding.UTF8.GetBytes(raw));
                return Convert.ToHexString(hash)[..24].ToLowerInvariant();
            }
            catch
            {
                return Guid.NewGuid().ToString("N")[..24];
            }
        }
    }

    public static Dictionary<string, object> Snapshot() => new()
    {
        ["os"] = Os,
        ["cpu"] = Cpu,
        ["memoryMb"] = MemoryMb,
        ["uptimeMinutes"] = Math.Round(UptimeMinutes, 1),
        ["logicalCores"] = Environment.ProcessorCount,
        ["userInteractive"] = Environment.UserName,
    };
}
