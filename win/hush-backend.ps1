# hush windows backend — per-user DPAPI-encrypted store. Called by the `hush` bash script.
#   store <name>   : reads the value from STDIN, DPAPI-encrypts it (CurrentUser), writes the ciphertext.
#   get   <name>   : decrypts and writes the PLAINTEXT to stdout (the bash caller captures it; hush
#                    itself never prints it). a human may also run this to read a value.
#   exists <name>  : exit 0 if present, 1 if not.
#   delete <name>  : remove it.
#   list           : print stored NAMES, one per line (never values).
# Namespace via $env:HUSH_NS (default "hush"). Files: %LOCALAPPDATA%\hush\<ns>\<name>, content is
# only DPAPI ciphertext (useless to any other user/machine). The value never appears on a command line.
# Written for Windows PowerShell 5.1 (no -AsPlainText on ConvertFrom-SecureString there).

$ErrorActionPreference = 'Stop'
$verb = $args[0]
$name = $args[1]
$ns   = if ($env:HUSH_NS) { $env:HUSH_NS } else { 'hush' }
$dir  = Join-Path $env:LOCALAPPDATA (Join-Path 'hush' $ns)
$path = if ($name) { Join-Path $dir $name } else { $null }

function Read-Stdin { [Console]::In.ReadToEnd() }

switch ($verb) {
  'store' {
    if (-not $name) { Write-Error 'store: name required'; exit 2 }
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $val = Read-Stdin
    $sec = ConvertTo-SecureString -String $val -AsPlainText -Force
    $enc = ConvertFrom-SecureString -SecureString $sec    # DPAPI, CurrentUser
    Set-Content -NoNewline -Path $path -Value $enc
    exit 0
  }
  'get' {
    if (-not (Test-Path -LiteralPath $path)) { Write-Error "no secret named '$name'"; exit 1 }
    $enc = Get-Content -Raw -LiteralPath $path
    $sec = ConvertTo-SecureString -String $enc            # DPAPI decrypt
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try   { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    exit 0
  }
  'exists' {
    if (Test-Path -LiteralPath $path) { exit 0 } else { exit 1 }
  }
  'delete' {
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
    exit 0
  }
  'list' {
    if (Test-Path -LiteralPath $dir) {
      Get-ChildItem -LiteralPath $dir -File | ForEach-Object { $_.Name }
    }
    exit 0
  }
  'prompt' {
    # pop a masked GUI box on the user's screen, write the entered value to stdout (the bash caller
    # captures it; hush never prints it). interactive only; needs a desktop session.
    Add-Type -AssemblyName PresentationFramework
    $w = New-Object Windows.Window
    $w.Title = 'hush set'; $w.SizeToContent = 'WidthAndHeight'; $w.WindowStartupLocation = 'CenterScreen'; $w.Topmost = $true
    $sp = New-Object Windows.Controls.StackPanel; $sp.Margin = 12
    $lbl = New-Object Windows.Controls.TextBlock; $lbl.Text = "paste the value for secret: $name"; $lbl.Margin = '0,0,0,8'
    $pb = New-Object Windows.Controls.PasswordBox; $pb.MinWidth = 320
    $ok = New-Object Windows.Controls.Button; $ok.Content = 'OK'; $ok.Margin = '0,8,0,0'; $ok.IsDefault = $true
    $ok.Add_Click({ $w.DialogResult = $true })
    [void]$sp.Children.Add($lbl); [void]$sp.Children.Add($pb); [void]$sp.Children.Add($ok)
    $w.Content = $sp; [void]$pb.Focus()
    if ($w.ShowDialog()) { [Console]::Out.Write($pb.Password) }
    exit 0
  }
  default { Write-Error "unknown verb '$verb'"; exit 2 }
}
