Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

Set ws = CreateObject("WScript.Shell")
ws.CurrentDirectory = scriptDir

' 0 = vbHide (no console window), False = non-blocking background launch
ws.Run "cmd.exe /c npm start", 0, False
