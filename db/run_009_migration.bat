@echo off
echo =================================================
echo   IXNEL STORAGE UPGRADE MIGRATION RUNNER
echo =================================================

:: Set your database password here
set DB_HOST=localhost
set DB_PORT=5432
set DB_NAME=animationproject
set DB_USER=superadmin

:: Run the specific migration file
echo Running 009_add_storage_mode.sql...
psql -h %DB_HOST% -p %DB_PORT% -U %DB_USER% -d %DB_NAME% -f migrations\009_add_storage_mode.sql

echo.
echo =================================================
echo   MIGRATION COMPLETE
echo =================================================
pause