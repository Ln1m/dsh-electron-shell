# Stamp the version-info resource (FileDescription / ProductName / CompanyName) into our exe copy,
# so Windows taskbar tooltips and toast attributions read "DeepSeek Harness" instead of "Electron".
# ASCII only.
$ErrorActionPreference = 'Stop'
$OutExe = 'D:\DeepSeek_harness\apps\dsh-electron-shell\runtime\electron\DeepSeekHarness.exe'
if (-not (Test-Path $OutExe)) { throw "missing $OutExe" }

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class ExeVersion {
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr BeginUpdateResource(string fileName, bool deleteExisting);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool UpdateResource(IntPtr hUpdate, IntPtr type, IntPtr name, ushort language, byte[] data, uint size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool EndUpdateResource(IntPtr hUpdate, bool discard);

  static void Word(List<byte> b, int v) { b.Add((byte)(v & 0xFF)); b.Add((byte)((v >> 8) & 0xFF)); }
  static void Dword(List<byte> b, uint v) { b.Add((byte)(v & 0xFF)); b.Add((byte)((v >> 8) & 0xFF)); b.Add((byte)((v >> 16) & 0xFF)); b.Add((byte)((v >> 24) & 0xFF)); }
  static void Pad(List<byte> b) { while ((b.Count % 4) != 0) b.Add(0); }
  static void Keyword(List<byte> b, string s) { foreach (char c in s) Word(b, c); Word(b, 0); }
  static void U16(List<byte> b, string s) { foreach (char c in s) Word(b, c); Word(b, 0); Pad(b); }

  static byte[] StringEntry(string key, string value) {
    var b = new List<byte>();
    Word(b, 0); Word(b, value.Length + 1); Word(b, 1);
    Keyword(b, key);
    Pad(b);
    U16(b, value);
    var arr = b.ToArray();
    int len = arr.Length;
    arr[0] = (byte)(len & 0xFF); arr[1] = (byte)((len >> 8) & 0xFF);
    return arr;
  }

  public static void Stamp(string path, string product, string description, string company, string version) {
    var parts = version.Split('.');
    int major = int.Parse(parts[0]), minor = int.Parse(parts[1]), build = int.Parse(parts[2]), rev = int.Parse(parts[3]);

    var table = new List<byte>();
    foreach (var kv in new[] {
      new[] { "CompanyName", company }, new[] { "FileDescription", description },
      new[] { "FileVersion", version }, new[] { "InternalName", product },
      new[] { "OriginalFilename", "DeepSeekHarness.exe" }, new[] { "ProductName", product },
      new[] { "ProductVersion", version } }) {
      table.AddRange(StringEntry(kv[0], kv[1]));
    }
    var tableArr = table.ToArray();
    var tableHeader = new List<byte>();
    Word(tableHeader, 0); Word(tableHeader, 0); Word(tableHeader, 1);
    Keyword(tableHeader, "040904B0");
    Pad(tableHeader);
    var full = new List<byte>();
    full.AddRange(tableHeader);
    full.AddRange(tableArr);
    var tableFull = full.ToArray();
    int tableLen = tableFull.Length;
    tableFull[0] = (byte)(tableLen & 0xFF); tableFull[1] = (byte)((tableLen >> 8) & 0xFF);

    var sfi = new List<byte>();
    Word(sfi, 0); Word(sfi, 0); Word(sfi, 1);
    Keyword(sfi, "StringFileInfo");
    Pad(sfi);
    sfi.AddRange(tableFull);
    var sfiArr = sfi.ToArray();
    int sfiLen = sfiArr.Length;
    sfiArr[0] = (byte)(sfiLen & 0xFF); sfiArr[1] = (byte)((sfiLen >> 8) & 0xFF);

    var vfiInner = new List<byte>();
    Word(vfiInner, 0); Word(vfiInner, 4); Word(vfiInner, 0);
    Keyword(vfiInner, "Translation");
    Pad(vfiInner);
    Dword(vfiInner, 0x040904B0);
    var vfiInnerArr = vfiInner.ToArray();
    int vfiInnerLen = vfiInnerArr.Length;
    vfiInnerArr[0] = (byte)(vfiInnerLen & 0xFF); vfiInnerArr[1] = (byte)((vfiInnerLen >> 8) & 0xFF);

    var vfi = new List<byte>();
    Word(vfi, 0); Word(vfi, 0); Word(vfi, 1);
    Keyword(vfi, "VarFileInfo");
    Pad(vfi);
    vfi.AddRange(vfiInnerArr);
    var vfiArr = vfi.ToArray();
    int vfiLen = vfiArr.Length;
    vfiArr[0] = (byte)(vfiLen & 0xFF); vfiArr[1] = (byte)((vfiLen >> 8) & 0xFF);

    var fixedInfo = new List<byte>();
    Dword(fixedInfo, 0xFEEF04BD);
    Dword(fixedInfo, 0x00010000);
    Dword(fixedInfo, (uint)((major << 16) | minor));
    Dword(fixedInfo, (uint)((build << 16) | rev));
    Dword(fixedInfo, (uint)((major << 16) | minor));
    Dword(fixedInfo, (uint)((build << 16) | rev));
    Dword(fixedInfo, 0x3F);
    Dword(fixedInfo, 0);
    Dword(fixedInfo, 0x00040004);
    Dword(fixedInfo, 0x00000001);
    Dword(fixedInfo, 0);
    Dword(fixedInfo, 0);
    Dword(fixedInfo, 0);
    var fixedArr = fixedInfo.ToArray();

    var root = new List<byte>();
    Word(root, 0); Word(root, fixedArr.Length); Word(root, 0);
    Keyword(root, "VS_VERSION_INFO");
    Pad(root);
    root.AddRange(fixedArr);
    Pad(root);
    root.AddRange(sfiArr);
    root.AddRange(vfiArr);
    var rootArr = root.ToArray();
    int rootLen = rootArr.Length;
    rootArr[0] = (byte)(rootLen & 0xFF); rootArr[1] = (byte)((rootLen >> 8) & 0xFF);

    IntPtr update = BeginUpdateResource(path, false);
    if (update == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    try {
      if (!UpdateResource(update, new IntPtr(16), new IntPtr(1), 0, rootArr, (uint)rootArr.Length))
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    } finally {
      if (!EndUpdateResource(update, false)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
  }
}
'@

[ExeVersion]::Stamp($OutExe, 'DeepSeek Harness', 'DeepSeek Harness', 'DeepSeek Harness', '0.1.0.0')
$info = (Get-Item $OutExe).VersionInfo
"FileDescription = " + $info.FileDescription
"ProductName     = " + $info.ProductName
"CompanyName     = " + $info.CompanyName
"FileVersion     = " + $info.FileVersion
