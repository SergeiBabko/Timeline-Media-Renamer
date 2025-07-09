@echo off
chcp 65001
cls

:run_or_install
if exist "node_modules" (
    echo Running Timeline Media Renamer...
    node "#TimelineMediaRenamer.js"
) else (
    echo Timeline Media Renamer
    echo Installing Dependencies...
    call npm install exiftool-vendored luxon
    goto run_or_install
)

pause
