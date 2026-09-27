using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows;
using System.Windows.Interop;
using AntiCheatAgent.Services;
using Microsoft.Web.WebView2.Core;

namespace AntiCheatAgent;

public partial class MainWindow : Window
{
    private const string HostName = "agent.anti-cheat.local";

    private AppConfig _config = new();
    private ApiClient? _api;
    private ApiClient.SessionInfo? _session;
    private CancellationTokenSource? _cts;
    private bool _running;
    private bool _finishedOk;

    public MainWindow()
    {
        InitializeComponent();
        Loaded += OnLoaded;
        Closed += (_, _) => _cts?.Cancel();
    }

    /* ------------------------------------------------------------ lifecycle */

    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        ApplyRoundedCorners();

        _config = AppConfig.Load();
        _api = new ApiClient(_config.PortalUrl);

        try
        {
            var userData = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "TournamentAntiCheat", "WebView2");
            var env = await CoreWebView2Environment.CreateAsync(null, userData);
            await WebView.EnsureCoreWebView2Async(env);

            var core = WebView.CoreWebView2;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsZoomControlEnabled = false;
            core.Settings.AreDevToolsEnabled = false;

            // Serve the packaged UI from the wwwroot folder next to the EXE.
            var wwwroot = Path.Combine(AppContext.BaseDirectory, "wwwroot");
            core.SetVirtualHostNameToFolderMapping(HostName, wwwroot, CoreWebView2HostResourceAccessKind.Allow);
            core.WebMessageReceived += OnWebMessage;
            core.NavigationStarting += (_, args) =>
            {
                if (!args.Uri.StartsWith($"https://{HostName}/", StringComparison.OrdinalIgnoreCase))
                    args.Cancel = true;
            };

            core.Navigate($"https://{HostName}/index.html");
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                "The Microsoft Edge WebView2 runtime is required but could not be started.\n\n" +
                "Install the WebView2 Runtime and run the agent again.\n\n" + ex.Message,
                "Tournament Anti-Cheat", MessageBoxButton.OK, MessageBoxImage.Error);
            Close();
        }
    }

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

    [DllImport("user32.dll")]
    private static extern bool ReleaseCapture();

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr hWnd, int Msg, IntPtr wParam, IntPtr lParam);

    private const int WM_NCLBUTTONDOWN = 0xA1;
    private const int HTCAPTION = 0x2;

    private void ApplyRoundedCorners()
    {
        try
        {
            var hwnd = new WindowInteropHelper(this).Handle;

            // DWMWA_USE_IMMERSIVE_DARK_MODE (20 on Win10 20H1+ and Win11; 19 on earlier Win10)
            int darkMode = 1;
            DwmSetWindowAttribute(hwnd, 20, ref darkMode, sizeof(int));
            DwmSetWindowAttribute(hwnd, 19, ref darkMode, sizeof(int));

            // DWMWA_WINDOW_CORNER_PREFERENCE (33): DWMWCP_ROUND (2)
            const int attr = 33;
            var preference = 2;
            DwmSetWindowAttribute(hwnd, attr, ref preference, sizeof(int));
        }
        catch { /* older Windows — square corners are fine */ }
    }

    /* ------------------------------------------------------------- messages */

    private void PostToJs(object payload)
    {
        try
        {
            var json = JsonSerializer.Serialize(payload);
            Dispatcher.Invoke(() => WebView.CoreWebView2?.PostWebMessageAsJson(json));
        }
        catch (Exception ex)
        {
            Debug.WriteLine("post to js failed: " + ex.Message);
        }
    }

    private sealed class Inbound
    {
        public string Type { get; set; } = "";
        public string Pin { get; set; } = "";
        public string PlayerName { get; set; } = "";
        public string ConsentAt { get; set; } = "";
    }

    private void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        Inbound? msg;
        try
        {
            msg = JsonSerializer.Deserialize<Inbound>(e.WebMessageAsJson,
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
        }
        catch { return; }
        if (msg == null) return;

        switch (msg.Type.ToLowerInvariant())
        {
            case "ready":
                PostToJs(new
                {
                    type = "config",
                    pin = _config.Pin,
                    playerName = _config.PlayerName,
                    portal = _api?.PortalUrl ?? "",
                    auto = _config.Auto,
                });
                break;

            case "continue":
                _ = ValidateAsync(msg);
                break;

            case "start":
                _ = ScanAsync(msg);
                break;

            case "minimize":
                Dispatcher.Invoke(() => WindowState = WindowState.Minimized);
                break;

            case "close":
            case "exit":
                Dispatcher.Invoke(Close);
                break;

            case "drag":
                Dispatcher.Invoke(() =>
                {
                    try
                    {
                        ReleaseCapture();
                        var hwnd = new WindowInteropHelper(this).Handle;
                        SendMessage(hwnd, WM_NCLBUTTONDOWN, (IntPtr)HTCAPTION, IntPtr.Zero);
                    }
                    catch { }
                });
                break;
        }
    }

    /* --------------------------------------------------------- validation */

    private async Task ValidateAsync(Inbound msg)
    {
        if (_api == null) return;
        var pin = (msg.Pin ?? "").Trim().ToUpperInvariant();
        if (pin.Length < 8)
        {
            PostToJs(new { type = "session", ok = false, error = "Enter the 8-character session PIN" });
            return;
        }

        try
        {
            var session = await _api.ValidatePinAsync(pin);
            _session = session;
            _config.Pin = pin;
            _config.PlayerName = (msg.PlayerName ?? "").Trim();
            PostToJs(new
            {
                type = "session",
                ok = true,
                session = new { id = session.Id, name = session.Name, game = session.Game, expiresAt = session.ExpiresAt },
            });
        }
        catch (Exception ex)
        {
            PostToJs(new { type = "session", ok = false, error = ex.Message });
        }
    }

    /* -------------------------------------------------------------- scan */

    private async Task ScanAsync(Inbound msg)
    {
        if (_api == null || _session == null || _running) return;
        _running = true;
        _cts = new CancellationTokenSource();

        var consentAt = DateTime.TryParse(msg.ConsentAt, out var t) ? t.ToUniversalTime() : DateTime.UtcNow;

        var orch = new ScanOrchestrator(
            _api, new ScanOrchestrator.SessionRef(_session.Id, _session.Name, _session.Game),
            _config.Pin, _config.PlayerName, _config.MinScanSeconds);

        orch.Progress += (pct, label) => PostToJs(new { type = "progress", pct, step = label });

        try
        {
            var result = await orch.RunAsync(consentAt, _cts.Token);
            _finishedOk = result.Uploaded;
            PostToJs(new
            {
                type = "done",
                verdict = result.Verdict,
                score = result.Score,
                findings = result.Findings,
                serious = result.Serious,
                uploaded = result.Uploaded,
                error = result.Error,
                autoCloseSeconds = result.Uploaded ? _config.AutoCloseSeconds : 0,
            });

            if (result.Uploaded && _config.AutoCloseSeconds > 0)
            {
                _ = Task.Run(async () =>
                {
                    await Task.Delay(TimeSpan.FromSeconds(_config.AutoCloseSeconds));
                    Dispatcher.Invoke(() => Close());
                });
            }
        }
        catch (Exception ex)
        {
            PostToJs(new
            {
                type = "done",
                verdict = "clean",
                score = 0,
                findings = 0,
                serious = 0,
                uploaded = false,
                error = ex.Message,
                autoCloseSeconds = 0,
            });
        }
        finally
        {
            _running = false;
        }
    }
}
