$ErrorActionPreference = "Stop"

$files = @(Get-ChildItem -Path "scripts", "tests" -Recurse -File -Filter "*.js")

foreach ($file in $files) {
    $source = Get-Content -Raw -LiteralPath $file.FullName
    $source | node --input-type=module --check
    if ($LASTEXITCODE -ne 0) {
        throw "Syntax check failed: $($file.FullName)"
    }
}

Write-Output "Syntax check passed for $($files.Count) JavaScript files."
