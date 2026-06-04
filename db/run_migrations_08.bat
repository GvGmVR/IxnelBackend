@echo off
echo =================================================
echo   IXNEL DATABASE MIGRATION RUNNER
echo =================================================

:: Set your database password here so it doesn't prompt you every time
set DB_HOST=localhost
set DB_PORT=5432
set DB_NAME=animationproject
set DB_USER=superadmin

:: Run the specific migration file
echo Running 008_create_projects_workspace.sql...
psql -h %DB_HOST% -p %DB_PORT% -U %DB_USER% -d %DB_NAME% -f migrations\008_create_projects_workspace.sql
echo.
echo =================================================
echo   MIGRATION COMPLETE
echo =================================================
pause