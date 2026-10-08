param([switch]$SkipStartup)
$ErrorActionPreference = 'Stop'

$AppDir  = 'D:\DeepSeek_harness\apps\dsh-electron-shell'
$Exe     = Join-Path $AppDir 'runtime\electron\DeepSeekHarness.exe'
$IconIco = Join-Path $AppDir 'assets\app.ico'
$Aumid   = 'Ln1m.DeepSeekHarness.Shell'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("00021401-0000-0000-C000-000000000046")]
internal class ShellLinkCoClass { }

[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
internal interface IShellLinkW {
  void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszFile, int cch, IntPtr pfd, int fFlags);
  void GetIDList(out IntPtr ppidl);
  void SetIDList(IntPtr pidl);
  void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszName, int cch);
  void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
  void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszDir, int cch);
  void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
  void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszArgs, int cch);
  void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);
  void GetHotkey(out short pwHotkey);
  void SetHotkey(short wHotkey);
  void GetShowCmd(out int piShowCmd);
  void SetShowCmd(int iShowCmd);
  void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszIconPath, int cch, out int piIcon);
  void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);
  void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, int dwReserved);
  void Resolve(IntPtr hwnd, int fFlags);
  void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
}

[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("0000010b-0000-0000-C000-000000000046")]
internal interface IPersistFile {
  void GetClassID(out Guid pClassID);
  void IsDirty();
  void Load([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, int dwMode);
  void Save([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, bool fRemember);
  void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string pszFileName);
  void GetCurFile(out IntPtr ppszFileName);
}

[StructLayout(LayoutKind.Sequential, Pack = 4)]
internal struct PropertyKey { public Guid fmtid; public int pid; }

[StructLayout(LayoutKind.Explicit)]
internal struct PropVariant {
  [FieldOffset(0)] public ushort vt;
  [FieldOffset(8)] public IntPtr pointerValue;
}

[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99")]
internal interface IPropertyStore {
  void GetCount(out uint cProps);
  void GetAt(uint iProp, out PropertyKey pkey);
  void GetValue(ref PropertyKey key, out PropVariant pv);
  void SetValue(ref PropertyKey key, ref PropVariant pv);
  void Commit();
}

public static class Lnk {
  public static void Write(string path, string target, string arguments, string workingDirectory,
                           string iconPath, string description, string aumid) {
    var link = (IShellLinkW)new ShellLinkCoClass();
    var file = (IPersistFile)link;
    link.SetPath(target);
    link.SetArguments(arguments);
    link.SetWorkingDirectory(workingDirectory);
    link.SetIconLocation(iconPath, 0);
    link.SetDescription(description);
    var store = (IPropertyStore)link;
    var key = new PropertyKey();
    key.fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
    key.pid = 5;
    var pv = new PropVariant();
    pv.vt = 31;
    pv.pointerValue = Marshal.StringToCoTaskMemUni(aumid);
    try {
      store.SetValue(ref key, ref pv);
      store.Commit();
      file.Save(path, true);
    } finally {
      Marshal.FreeCoTaskMem(pv.pointerValue);
      Marshal.ReleaseComObject(store);
      Marshal.ReleaseComObject(link);
    }
  }

  public static string Read(string path) {
    var link = (IShellLinkW)new ShellLinkCoClass();
    var file = (IPersistFile)link;
    file.Load(path, 0);
    var store = (IPropertyStore)link;
    var key = new PropertyKey();
    key.fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
    key.pid = 5;
    PropVariant pv;
    string value;
    try {
      store.GetValue(ref key, out pv);
      value = pv.vt == 31 && pv.pointerValue != IntPtr.Zero ? Marshal.PtrToStringUni(pv.pointerValue) : ("vt=" + pv.vt);
    } catch (Exception error) {
      value = "MISSING (" + error.GetType().Name + ")";
    } finally {
      Marshal.ReleaseComObject(store);
      Marshal.ReleaseComObject(link);
    }
    return value;
  }
}
'@

function Write-ShellShortcut([string]$Path) {
  [Lnk]::Write($Path, $Exe, ('"' + $AppDir + '"'), 'D:\DeepSeek_harness', $IconIco, 'DeepSeek Harness', $Aumid)
  "written: $Path  aumid=" + [Lnk]::Read($Path)
}

$desktopDir = [Environment]::GetFolderPath('Desktop')
$menuDir = [Environment]::GetFolderPath('Programs')
Get-ChildItem $desktopDir -Filter '*.lnk' | ForEach-Object {
  $t = (New-Object -ComObject WScript.Shell).CreateShortcut($_.FullName).TargetPath
  if ($t -like '*dsh-electron-shell*') { Remove-Item $_.FullName -Force }
}
Get-ChildItem $menuDir -Filter '*.lnk' | ForEach-Object {
  $t = (New-Object -ComObject WScript.Shell).CreateShortcut($_.FullName).TargetPath
  if ($t -like '*dsh-electron-shell*') { Remove-Item $_.FullName -Force }
}

Write-ShellShortcut (Join-Path $desktopDir 'DeepSeek Harness.lnk')
Write-ShellShortcut (Join-Path $menuDir 'DeepSeek Harness.lnk')

$taskbarDir = Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'
if (Test-Path $taskbarDir) {
  $probe = New-Object -ComObject WScript.Shell
  $stale = @()
  Get-ChildItem $taskbarDir -Filter '*.lnk' | ForEach-Object {
    $target = $probe.CreateShortcut($_.FullName).TargetPath
    if (($target -like '*dsh-electron-shell*') -or ($target -like '*dsh-desktop*')) {
      if ($_.Name -ne 'DeepSeek Harness.lnk') { $stale += $_ }
    }
  }
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($probe) | Out-Null
  foreach ($pin in $stale) {
    $backup = 'D:\DeepSeek_harness\backups\dsh-shell-handover-20261008'
    New-Item -ItemType Directory -Force -Path $backup | Out-Null
    Move-Item $pin.FullName (Join-Path $backup ($pin.Name + '.retired')) -Force
    "retired stale taskbar pin (" + $pin.Name + ") -> backup " + $backup
  }
  Write-ShellShortcut (Join-Path $taskbarDir 'DeepSeek Harness.lnk')
}

if (-not $SkipStartup) {
  $startupDir = [Environment]::GetFolderPath('Startup')
  $probe = New-Object -ComObject WScript.Shell
  Get-ChildItem $startupDir -Filter *.lnk | ForEach-Object {
    $target = $probe.CreateShortcut($_.FullName).TargetPath
    if ($target -like '*DSH-Tray.exe') {
      $backup = 'D:\DeepSeek_harness\backups\dsh-shell-handover-20261008'
      New-Item -ItemType Directory -Force -Path $backup | Out-Null
      Copy-Item $_.FullName (Join-Path $backup $_.Name) -Force
      Remove-Item $_.FullName -Force
      "retired old startup entry (" + $_.Name + ") -> backup " + $backup
    }
  }
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($probe) | Out-Null
  Get-ChildItem $startupDir -Filter '*.lnk' | ForEach-Object {
    $t = (New-Object -ComObject WScript.Shell).CreateShortcut($_.FullName).TargetPath
    if ($t -like '*dsh-electron-shell*' -and $_.Name -ne 'DeepSeek Harness.lnk') { Remove-Item $_.FullName -Force }
  }
  Write-ShellShortcut (Join-Path $startupDir 'DeepSeek Harness.lnk')
}

"--- startup folder now ---"
Get-ChildItem ([Environment]::GetFolderPath('Startup')) -Filter *.lnk | Select-Object -ExpandProperty Name
