@echo off
:: ============================================================
:: run_migrations.bat
:: Runs all migration SQL files in order
:: ============================================================

set DB_HOST=localhost
set DB_PORT=5432
set DB_NAME=animationproject
set DB_USER=superadmin

echo.
echo ============================================================
echo  Running migrations on %DB_NAME%
echo ============================================================
echo.

psql -h %DB_HOST% -p %DB_PORT% -U %DB_USER% -d %DB_NAME% -f migrations\001_create_enums.sql
echo [001] ENUMs created

psql -h %DB_HOST% -p %DB_PORT% -U %DB_USER% -d %DB_NAME% -f migrations\002_create_auth_users.sql
echo [002] auth_users created

psql -h %DB_HOST% -p %DB_PORT% -U %DB_USER% -d %DB_NAME% -f migrations\003_create_profiles.sql
echo [003] profiles created

psql -h %DB_HOST% -p %DB_PORT% -U %DB_USER% -d %DB_NAME% -f migrations\004_create_credit_transactions.sql
echo [004] credit_transactions created

psql -h %DB_HOST% -p %DB_PORT% -U %DB_USER% -d %DB_NAME% -f migrations\005_create_jobs.sql
echo [005] jobs created

psql -h %DB_HOST% -p %DB_PORT% -U %DB_USER% -d %DB_NAME% -f migrations\006_create_payments.sql
echo [006] payments created

echo.
echo ============================================================
echo  All migrations completed
echo ============================================================
echo.
pause