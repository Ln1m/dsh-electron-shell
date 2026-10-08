Option Explicit
Dim sh, fso, appDir, exe
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
exe = appDir & "\runtime\electron\DeepSeekHarness.exe"
If Not fso.FileExists(exe) Then
  MsgBox "DeepSeekHarness.exe is missing." & vbCrLf & "Rebuild it from a pristine Electron with: make-icon.ps1 -Source <electron.exe>", 16, "DeepSeek Harness"
  WScript.Quit 1
End If
sh.CurrentDirectory = "D:\DeepSeek_harness"
sh.Run """" & exe & """ """ & appDir & """", 0, False
