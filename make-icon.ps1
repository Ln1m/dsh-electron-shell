# Build a multi-size ICO from the official render and stamp it into our own Electron copy
# via the Win32 resource API (no rcedit on this machine). ASCII only.
param([string]$Source = $env:DSH_ELECTRON_PRISTINE)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$AppDir  = 'D:\DeepSeek_harness\apps\dsh-electron-shell'
$SrcPng  = Join-Path $AppDir 'assets\app.png'
$OutIco  = Join-Path $AppDir 'assets\app.ico'
$SrcExe  = $Source
$OutExe  = Join-Path $AppDir 'runtime\electron\DeepSeekHarness.exe'
if ([string]::IsNullOrEmpty($SrcExe) -or -not (Test-Path -LiteralPath $SrcExe)) {
  throw 'Pass -Source <path to a pristine electron.exe> (or set DSH_ELECTRON_PRISTINE).'
}

$sizes = @(16, 24, 32, 48, 64, 128, 256)
$frames = @()
foreach ($s in $sizes) {
  $image = [System.Drawing.Image]::FromFile($SrcPng)
  $bmp = New-Object System.Drawing.Bitmap($s, $s)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.DrawImage($image, 0, 0, $s, $s)
  $g.Dispose(); $image.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $frames += , $ms.ToArray()
  $bmp.Dispose(); $ms.Dispose()
}

$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($ms)
$bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]; $data = $frames[$i]
  $dim = if ($s -ge 256) { [Byte]0 } else { [Byte]$s }
  $bw.Write($dim); $bw.Write($dim)
  $bw.Write([Byte]0); $bw.Write([Byte]0)
  $bw.Write([UInt16]1); $bw.Write([UInt16]32)
  $bw.Write([UInt32]$data.Length); $bw.Write([UInt32]$offset)
  $offset += $data.Length
}
foreach ($d in $frames) { $bw.Write($d) }
$bw.Flush()
[IO.File]::WriteAllBytes($OutIco, $ms.ToArray())
$bw.Dispose(); $ms.Dispose()
"ico written: $OutIco  frames=$($sizes.Count)  bytes=" + (Get-Item $OutIco).Length

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class ExeIcon {
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr BeginUpdateResource(string fileName, bool deleteExisting);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool UpdateResource(IntPtr hUpdate, IntPtr type, IntPtr name, ushort language, byte[] data, uint size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool EndUpdateResource(IntPtr hUpdate, bool discard);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr LoadLibraryEx(string fileName, IntPtr file, uint flags);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool FreeLibrary(IntPtr module);
  delegate bool EnumResNameProc(IntPtr module, IntPtr type, IntPtr name, IntPtr param);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool EnumResourceNames(IntPtr module, IntPtr type, EnumResNameProc callback, IntPtr param);

  /** Resource ids of RT_GROUP_ICON (14) in the module. */
  public static int[] IconGroups(string path) {
    var found = new List<int>();
    IntPtr module = LoadLibraryEx(path, IntPtr.Zero, 0x00000002);
    if (module == IntPtr.Zero) return found.ToArray();
    try {
      EnumResourceNames(module, new IntPtr(14), delegate(IntPtr m, IntPtr t, IntPtr name, IntPtr p) {
        found.Add(name.ToInt32());
        return true;
      }, IntPtr.Zero);
    } finally { FreeLibrary(module); }
    return found.ToArray();
  }

  /** Replace RT_ICON id 1..n and every RT_GROUP_ICON with the given PNG frames. */
  public static void Stamp(string path, byte[][] frames, int[] groupIds) {
    IntPtr update = BeginUpdateResource(path, false);
    if (update == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    try {
      for (int i = 0; i < frames.Length; i += 1) {
        if (!UpdateResource(update, new IntPtr(3), new IntPtr(i + 1), 0, frames[i], (uint)frames[i].Length))
          throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      }
      var group = new List<byte>();
      Action<ushort> word = (v) => { group.Add((byte)(v & 0xFF)); group.Add((byte)(v >> 8)); };
      Action<uint> dword = (v) => { group.Add((byte)v); group.Add((byte)(v >> 8)); group.Add((byte)(v >> 16)); group.Add((byte)(v >> 24)); };
      word(0); word(1); word((ushort)frames.Length);
      for (int i = 0; i < frames.Length; i += 1) {
        int size = 0; // derived below from the ico entry order: 16,24,32,48,64,128,256
        int[] dims = new int[] { 16, 24, 32, 48, 64, 128, 256 };
        size = dims[i];
        group.Add((byte)(size >= 256 ? 0 : size));
        group.Add((byte)(size >= 256 ? 0 : size));
        group.Add(0); group.Add(0);
        word(1); word(32);
        dword((uint)frames[i].Length);
        word((ushort)(i + 1));
      }
      byte[] groupBytes = group.ToArray();
      foreach (int id in groupIds) {
        if (!UpdateResource(update, new IntPtr(14), new IntPtr(id), 0, groupBytes, (uint)groupBytes.Length))
          throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      }
    } finally {
      if (!EndUpdateResource(update, false)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
  }

  public static double Mean(System.Drawing.Bitmap bmp) {
    if (bmp == null) return -1;
    double sum = 0; int n = 0;
    for (int y = 0; y < bmp.Height; y += 2) {
      for (int x = 0; x < bmp.Width; x += 2) {
        var c = bmp.GetPixel(x, y);
        sum += (c.R + c.G + c.B) / 3.0; n += 1;
      }
    }
    return n == 0 ? -2 : Math.Round(sum / n, 1);
  }
}
'@ -ReferencedAssemblies System.Drawing

Copy-Item $SrcExe $OutExe -Force
$groups = [ExeIcon]::IconGroups($OutExe)
"exe icon groups: " + ($groups -join ',')
[ExeIcon]::Stamp($OutExe, $frames, $groups)
"stamped: $OutExe  bytes=" + (Get-Item $OutExe).Length

$ref = New-Object System.Drawing.Bitmap($SrcPng)
$ref32 = New-Object System.Drawing.Bitmap(32, 32)
$rg = [System.Drawing.Graphics]::FromImage($ref32)
$rg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$rg.DrawImage($ref, 0, 0, 32, 32)
$rg.Dispose(); $ref.Dispose()
$before = [ExeIcon]::Mean([System.Drawing.Icon]::ExtractAssociatedIcon($SrcExe).ToBitmap())
$after = [ExeIcon]::Mean([System.Drawing.Icon]::ExtractAssociatedIcon($OutExe).ToBitmap())
"mean brightness  electron.exe=$before   DeepSeekHarness.exe=$after   official32=$([ExeIcon]::Mean($ref32))"
