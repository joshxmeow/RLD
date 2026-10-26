Option Explicit

Dim shell, fileSystem, projectDir, pythonPath, appPath, logPath, command
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

projectDir = fileSystem.GetParentFolderName(WScript.ScriptFullName)
pythonPath = fileSystem.BuildPath(projectDir, ".venv\Scripts\python.exe")
appPath = fileSystem.BuildPath(projectDir, "app.py")
logPath = fileSystem.BuildPath(projectDir, "server.log")

If Not fileSystem.FileExists(pythonPath) Or Not fileSystem.FileExists(appPath) Then
    WScript.Quit 1
End If

shell.CurrentDirectory = projectDir
command = "cmd.exe /d /c """ & Quote(pythonPath) & " " & Quote(appPath) & _
    " >> " & Quote(logPath) & " 2>&1"""
shell.Run command, 0, False

Function Quote(value)
    Quote = Chr(34) & value & Chr(34)
End Function
