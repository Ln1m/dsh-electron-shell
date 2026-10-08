Add-Type -AssemblyName System.Drawing
$src = 'D:\DeepSeek_harness\apps\dsh-electron-shell\assets\app.png'
$exe = 'D:\DeepSeek_harness\apps\dsh-electron-shell\runtime\electron\DeepSeekHarness.exe'

Add-Type -TypeDefinition @"
using System;
using System.Drawing;
using System.Runtime.InteropServices;
public class WinIcon {
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, int Msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool GetIconInfo(IntPtr hIcon, out ICONINFO piconinfo);
  [StructLayout(LayoutKind.Sequential)] public struct ICONINFO { public bool fIcon; public int xHotspot; public int yHotspot; public IntPtr hbmMask; public IntPtr hbmColor; }
  public static Bitmap Grab(IntPtr hwnd, int which) {
    IntPtr h = SendMessage(hwnd, 0x007F, (IntPtr)which, IntPtr.Zero);
    if (h == IntPtr.Zero) return null;
    ICONINFO info;
    if (!GetIconInfo(h, out info)) return null;
    try { return Bitmap.FromHbitmap(info.hbmColor); } catch { return null; }
  }
  public static double Mean(Bitmap bmp) {
    if (bmp == null) return -1;
    double sum = 0; int n = 0;
    int sx = Math.Max(1, bmp.Width / 16);
    int sy = Math.Max(1, bmp.Height / 16);
    for (int y = 0; y < bmp.Height; y += sy) {
      for (int x = 0; x < bmp.Width; x += sx) {
        Color c = bmp.GetPixel(x, y);
        if (c.A < 8) continue;
        sum += (c.R + c.G + c.B) / 3.0; n++;
      }
    }
    return n == 0 ? -2 : Math.Round(sum / n, 1);
  }
  public static string Size(Bitmap bmp) { return bmp == null ? "null" : (bmp.Width + "x" + bmp.Height); }
}
"@ -ReferencedAssemblies System.Drawing

$proc = Get-Process DeepSeekHarness,electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
if ($proc -eq $null) { 'NO electron main window'; exit 0 }
"electron pid=" + $proc.Id + " hwnd=" + $proc.MainWindowHandle

$big = [WinIcon]::Grab($proc.MainWindowHandle, 1)
$small = [WinIcon]::Grab($proc.MainWindowHandle, 0)
"window ICON_BIG   mean=" + [WinIcon]::Mean($big) + " size=" + [WinIcon]::Size($big)
"window ICON_SMALL mean=" + [WinIcon]::Mean($small) + " size=" + [WinIcon]::Size($small)

$ref = New-Object System.Drawing.Bitmap $src
"reference PNG     mean=" + [WinIcon]::Mean($ref) + " size=" + [WinIcon]::Size($ref)

$exeIcon = [System.Drawing.Icon]::ExtractAssociatedIcon($exe)
"electron.exe ico  mean=" + [WinIcon]::Mean($exeIcon.ToBitmap()) + " size=" + [WinIcon]::Size($exeIcon.ToBitmap())
