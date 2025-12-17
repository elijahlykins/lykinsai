# PowerShell script to restart the Node server
Write-Host "Stopping Node server processes..." -ForegroundColor Yellow

# Find and stop node processes (be careful - this stops ALL node processes)
# You may want to manually stop just the server process
$nodeProcesses = Get-Process -Name node -ErrorAction SilentlyContinue
if ($nodeProcesses) {
    Write-Host "Found $($nodeProcesses.Count) Node process(es)" -ForegroundColor Yellow
    Write-Host "Please manually stop your server (Ctrl+C in the terminal where it's running)" -ForegroundColor Yellow
    Write-Host "Then run: npm run server" -ForegroundColor Green
} else {
    Write-Host "No Node processes found. Starting server..." -ForegroundColor Green
    npm run server
}

