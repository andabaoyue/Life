Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

Set ws = CreateObject("WScript.Shell")
ws.CurrentDirectory = scriptDir

electronExe = fso.BuildPath(scriptDir, "node_modules\electron\dist\electron.exe")
If fso.FileExists(electronExe) Then
  ' Prefer direct electron.exe launch with absolute path (no PATH hijack risk)
  ws.Run """" & electronExe & """ """ & scriptDir & """", 0, False
ElseIf fso.FolderExists(fso.BuildPath(scriptDir, "node_modules")) Then
  sysRoot = ws.ExpandEnvironmentStrings("%SystemRoot%")
  cmdExe = fso.BuildPath(sysRoot, "System32\cmd.exe")
  If Not fso.FileExists(cmdExe) Then
    MsgBox "System cmd.exe not found: " & cmdExe, vbCritical, "Life"
    WScript.Quit 1
  End If
  rc = ws.Run("""" & cmdExe & """ /c npm start", 0, True)
  If rc <> 0 Then
    MsgBox "Failed to launch Life (exit code " & rc & "). Please run 'npm install' in " & scriptDir & ".", vbCritical, "Life"
    WScript.Quit rc
  End If
Else
  MsgBox "Missing dependencies (node_modules\electron\dist\electron.exe not found). Please run 'npm install' first.", vbExclamation, "Life"
  WScript.Quit 1
End If
