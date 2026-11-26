' Thin forwarder to 启动Life.vbs (keeps dual entrypoints without duplicating launch logic)
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
mainLauncher = fso.BuildPath(scriptDir, "启动Life.vbs")
If Not fso.FileExists(mainLauncher) Then
  MsgBox "Missing launcher script: " & mainLauncher, vbCritical, "Life"
  WScript.Quit 1
End If
Set ws = CreateObject("WScript.Shell")
sysRoot = ws.ExpandEnvironmentStrings("%SystemRoot%")
wscriptExe = fso.BuildPath(sysRoot, "System32\wscript.exe")
If Not fso.FileExists(wscriptExe) Then wscriptExe = "wscript.exe"
ws.Run """" & wscriptExe & """ """ & mainLauncher & """", 0, False
