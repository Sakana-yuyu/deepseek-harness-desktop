<#
.SYNOPSIS
    Read-only diagnosis, and whitelisted repair, of Windows ACL objects that the
    DSH sandbox cannot open.

.DESCRIPTION
    A denial inside the DSH sandbox is worth diagnosing only when it contradicts
    what the active mode promises: writes inside the workspace, or reads that the
    signed-in user should plainly have. This script reports why such an object is
    unreadable or unopenable, and repairs package-ACE conflicts or missing rights.

    Diagnosis (the default) never changes ACLs: it reads each requested path
    and every ancestor with .NET and native icacls, and prints machine-parseable
    lines for the caller to interpret. REPORT JSON records distinguish observed
    facts, decisions and their reasons, attempted operations, and verification.
    A caught exception still emits the operation history and recovery commands.
    Failed repairs restore attempted DACL changes in reverse order and stop.

    Repair (-Fix) removes ONLY allow ACEs whose SID is an AppContainer package SID
    (S-1-15-2-*, excluding the well-known groups ending in 1 or 2). Removing them
    also removes that package's access. Repair requires
    -AllowRoot, refuses any target outside it or reached through a reparse point,
    and records a DACL backup with an independent recovery script. The grant checks
    effective rights; removal verifies that other icacls lines remain unchanged.

    The script never creates, deletes, or writes the contents of any file. Its
    only content writes are recovery artifacts and explicitly requested reports.

.PARAMETER Path
    One or more failing paths. Each is diagnosed together with its ancestors.

.PARAMETER AllowRoot
    Required with any mutation. Every modified object must be strictly inside this directory.

.PARAMETER Out
    Required with -Fix, -GrantFullControl or -Compact. Receives recovery artifacts
    and, with -Compact, a unique full JSONL report.

.PARAMETER Compact
    Save every REPORT record under -Out and print a decision summary with the
    inspected paths, findings, actions, verification and pending recovery commands.

.PARAMETER Fix
    Remove individual package allow ACEs, preserving well-known package groups.
    Without a mutation switch, only diagnose.

.PARAMETER GrantFullControl
    Grant the current user full control on the requested path. Full control is what
    the documented precondition needs: it carries WRITE_DAC for the DACL and
    WRITE_OWNER for the mandatory label DSH writes in the same call, while taking
    ownership supplies only WRITE_DAC. The owner is never changed. Mutually
    exclusive with -Fix.

.PARAMETER Restore
    Restore the DACL recovery record for exactly one -Path. Requires -AllowRoot
    and WRITE_DAC, preserves owner and SACL, and is exclusive with either repair.

.EXAMPLE
    pwsh -File diagnose-windows-sandbox-acl.ps1 -Path 'C:\Users\me\.ssh'

.EXAMPLE
    pwsh -File diagnose-windows-sandbox-acl.ps1 -Path '<workspace>\.dsh-acl-fixture-x\case1' -AllowRoot '<workspace>\.dsh-acl-fixture-x' -Out '<workspace>\.dsh-acl-fixture-x\report' -Fix
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string[]]$Path,
  [string]$AllowRoot,
  [string]$Out,
  [switch]$Fix,
  [switch]$GrantFullControl,
  [string]$Restore,
  [switch]$Compact
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# These two well-known groups name all packages, not one conflicting package.
$PACKAGE_SID = '^S-1-15-2-(?![12]$)'
$LOW_LABEL_SID = 'S-1-16-4096'

function Write-Line { param([string]$Text) if (-not $Compact) { Write-Output $Text } }

# Reports bypass the success pipeline so diagnostics cannot become a function's
# return value. Each JSON record occupies one stdout line, including paths/errors.
function Write-Report {
  param([string]$Kind, [string]$Operation, [string]$Target, [string]$Status, [string]$Reason, $Details = @{})
  $record = [ordered]@{ kind = $Kind; operation = $Operation; path = $Target; status = $Status; reason = $Reason; details = $Details }
  $script:reports.Add($record)
  if ($Kind -eq 'observation' -and $Status -in @('unknown', 'unreadable', 'partial')) { $script:observationFailures++ }
  $json = $record | ConvertTo-Json -Depth 12 -Compress
  if ($script:reportWriter) {
    try { $script:reportWriter.WriteLine($json); $script:reportWriter.Flush() }
    catch {
      $script:reportWriter.Dispose()
      $script:reportWriter = $null
      $script:reportFailed = $true
      [Console]::Out.WriteLine('REPORT ' + $json)
      throw
    }
  }
  if (-not $Compact -or $script:reportFailed) { [Console]::Out.WriteLine('REPORT ' + $json) }
}

function Invoke-ReportedOperation {
  param([string]$Operation, [string]$Target, [string]$Reason, [string]$Effect, [scriptblock]$Action)
  $entry = [ordered]@{ id = $script:operations.Count + 1; operation = $Operation; path = $Target; effect = $Effect; status = 'started' }
  $script:operations.Add($entry)
  if ($Effect -eq 'acl' -and $Operation -ne 'restore_dacl' -and $script:recoveries.Count -gt 0) {
    $script:recoveries[-1].attempted = $true
  }
  Write-Report action $Operation $Target started $Reason @{ id = $entry.id; effect = $Effect }
  try {
    $result = & $Action
    $entry.status = 'completed'
    Write-Report action $Operation $Target completed $Reason @{ id = $entry.id; effect = $Effect }
    return $result
  } catch {
    $entry.status = 'failed'
    Write-Report action $Operation $Target failed $Reason @{
      id = $entry.id; effect = $Effect; error = (Get-HResultChain $_.Exception)
      state = $(if ($Effect -eq 'none') { 'No mutation requested by this operation.' } else { 'The operation may have partially changed state; completion is unconfirmed.' })
    }
    throw
  }
}

function Write-Decision {
  param([string]$Operation, [string]$Target, [string]$Status, [string]$Reason)
  Write-Report decision $Operation $Target $Status $Reason
}

# Unwrap nested exceptions: PowerShell wraps Win32 failures, and only the inner
# exception carries the real HRESULT the caller needs to classify the failure.
function Get-HResultChain {
  param([System.Exception]$Exception)
  $chain = @()
  $e = $Exception
  while ($null -ne $e) {
    $chain += ('{0}=0x{1:X8}/win32={2}: {3}' -f $e.GetType().Name, $e.HResult, ($e.HResult -band 0xFFFF), $e.Message)
    $e = $e.InnerException
  }
  return ($chain -join ' <- ')
}

function Get-CurrentIdentity {
  return [System.Security.Principal.WindowsIdentity]::GetCurrent()
}

# Integrity level affects the symptom: the same foreign
# ACE fails a grant when the caller is below Medium and merely blocks the child
# when the caller is not.
# The integrity level lives in the token's group list, which .NET filters out of
# WindowsIdentity.Groups, so read it through GetTokenInformation. Add-Type compiles
# in-process on PowerShell 7. Never spawn whoami.exe for this: inside a below-Medium
# token that process fails to initialize (STATUS_DLL_INIT_FAILED, 0xc0000142) and
# raises an application-error dialog on the user's desktop.
function Initialize-NativeApi {
    if (-not ('Dsh.TokenInfo' -as [type])) {
      Add-Type -Namespace Dsh -Name TokenInfo -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)]
public struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
[StructLayout(LayoutKind.Sequential)]
public struct TOKEN_MANDATORY_LABEL { public SID_AND_ATTRIBUTES Label; }
[DllImport("advapi32.dll", SetLastError = true)]
public static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr info, uint length, out uint returned);
[DllImport("advapi32.dll", SetLastError = true)]
public static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
[DllImport("advapi32.dll", SetLastError = true)]
public static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
private static extern Microsoft.Win32.SafeHandles.SafeFileHandle CreateFileW(
  string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
// OPEN_EXISTING never creates or changes contents. Windows evaluates the caller's
// effective access, including group attributes, denies, ownership and inheritance.
public static bool HasAccess(string path, uint access) {
  using (var handle = CreateFileW(path, access, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
    if (!handle.IsInvalid) { return true; }
    int error = Marshal.GetLastWin32Error();
    if (error == 5) { return false; }
    throw new System.ComponentModel.Win32Exception(error, "CreateFileW access check: " + path);
  }
}
[DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
private static extern uint SetNamedSecurityInfoW(string path, int type, uint information,
  IntPtr owner, IntPtr group, byte[] dacl, IntPtr sacl);
public static void SetDacl(string path, string sddl) {
  var descriptor = new System.Security.AccessControl.RawSecurityDescriptor(sddl);
  byte[] dacl = null;
  if (descriptor.DiscretionaryAcl != null) {
    dacl = new byte[descriptor.DiscretionaryAcl.BinaryLength];
    descriptor.DiscretionaryAcl.GetBinaryForm(dacl, 0);
  }
  bool isProtected = (descriptor.ControlFlags & System.Security.AccessControl.ControlFlags.DiscretionaryAclProtected) != 0;
  // Only the DACL and its inheritance protection are written: never owner, group or SACL.
  uint result = SetNamedSecurityInfoW(path, 1, 4u | (isProtected ? 0x80000000u : 0x20000000u),
    IntPtr.Zero, IntPtr.Zero, dacl, IntPtr.Zero);
  if (result != 0) { throw new System.ComponentModel.Win32Exception((int)result, "Write DACL: " + path); }
}
public static int Level(IntPtr token) {
  uint length;
  GetTokenInformation(token, 25, IntPtr.Zero, 0, out length);
  if (length == 0) { throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "Read integrity information length"); }
  IntPtr buffer = Marshal.AllocHGlobal((int)length);
  try {
    if (!GetTokenInformation(token, 25, buffer, length, out length)) { throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "Read integrity information"); }
    IntPtr sid = Marshal.PtrToStructure<TOKEN_MANDATORY_LABEL>(buffer).Label.Sid;
    byte count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
    return Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(count - 1)));
  } finally { Marshal.FreeHGlobal(buffer); }
}
'@
    }
}

function Get-IntegritySid {
  try {
    $level = [Dsh.TokenInfo]::Level([System.Security.Principal.WindowsIdentity]::GetCurrent().Token)
    switch ($level) {
      0 { return 'S-1-16-0 (Untrusted)' }
      4096 { return 'S-1-16-4096 (Low)' }
      8192 { return 'S-1-16-8192 (Medium)' }
      12288 { return 'S-1-16-12288 (High)' }
      16384 { return 'S-1-16-16384 (System)' }
      default { return "S-1-16-$level (unrecognized level)" }
    }
  } catch {
    Write-Report observation integrity '' unknown 'The token integrity level could not be read; do not infer that the caller is elevated or confined.' @{ error = (Get-HResultChain $_.Exception) }
    return 'unknown'
  }
}

function Get-NormalizedPath {
  param([string]$Value)
  $full = [System.IO.Path]::GetFullPath($Value)
  $root = [System.IO.Path]::GetPathRoot($full)
  if ($full.Length -le $root.Length) { return $root }
  return $full.TrimEnd('\', '/')
}

function Test-DangerousRoot {
  param([string]$FullPath)
  $trimmed = (Get-NormalizedPath $FullPath).TrimEnd('\')
  if ($trimmed -match '^[A-Za-z]:$') { return 'drive root' }
  if ($trimmed -ieq ([System.IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd('\'))) { return 'user profile root' }
  if ($trimmed -ieq ([System.IO.Path]::GetFullPath($env:WINDIR).TrimEnd('\'))) { return 'Windows directory' }
  foreach ($entry in @(
    @{ directory = $env:LOCALAPPDATA; child = 'Packages' },
    @{ directory = $env:ProgramFiles; child = 'WindowsApps' },
    @{ directory = $env:ProgramW6432; child = 'WindowsApps' }
  )) {
    if (-not $entry.directory) { continue }
    $protected = Get-NormalizedPath (Join-Path $entry.directory $entry.child)
    if ($trimmed -ieq $protected -or (Test-UnderRoot $trimmed $protected)) { return 'managed application directory' }
  }
  return $null
}

function Test-UnderRoot {
  param([string]$FullPath, [string]$Root)
  $r = Get-NormalizedPath $Root
  $c = Get-NormalizedPath $FullPath
  return $c -ine $r -and $c.StartsWith($r.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-RepairRefusal {
  param([string]$FullPath, [string]$Root)
  if (-not (Test-UnderRoot -FullPath $FullPath -Root $Root)) { return "$FullPath is outside -AllowRoot" }
  $danger = Test-DangerousRoot -FullPath $FullPath
  if ($danger) { return "$FullPath is a $danger" }
  # Checking every component also covers a junction used as AllowRoot itself.
  foreach ($component in (Get-Ancestors -FullPath $FullPath)) {
    $item = Get-Item -LiteralPath $component -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      return "$FullPath traverses a reparse point: $component"
    }
  }
  return $null
}

function Save-AclBackup {
  param([string]$FullPath, [string]$Directory, [string]$Root)
  $fullDirectory = [System.IO.Path]::GetFullPath($Directory)
  if (-not (Test-Path -LiteralPath $fullDirectory)) {
    Invoke-ReportedOperation create_backup_directory $fullDirectory 'The requested recovery directory does not exist; create it before writing backup files.' files {
      New-Item -ItemType Directory -Path $fullDirectory | Out-Null
    }
  }
  $backup = Join-Path $fullDirectory ('acl-backup-{0}.txt' -f ([guid]::NewGuid().ToString('N')))
  $record = $backup + '.json'
  # The skill's extracted directory expires with its registration. Recovery must
  # remain runnable from the backup directory after that registration is gone.
  $restoreScript = $backup + '.ps1'
  $command = "pwsh -NoProfile -File '{0}' -Path '{1}' -AllowRoot '{2}' -Restore '{3}'" -f
    $restoreScript.Replace("'", "''"), $FullPath.Replace("'", "''"), ([System.IO.Path]::GetFullPath($Root)).Replace("'", "''"), $record.Replace("'", "''")
  Write-Report decision backup $FullPath selected 'All recovery files must be written successfully before attempting the ACL change.' @{ files = @($backup, $record, $restoreScript, ($backup + '.rollback.txt')) }
  Invoke-ReportedOperation backup $FullPath 'Save the original DACL and an independent recovery command before changing permissions.' files {
    $output = @(icacls $FullPath /save $backup 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "Could not back up the DACL (icacls exit $LASTEXITCODE): $($output -join "`n")" }
    @{ Path = $FullPath; Dacl = (Get-Acl -LiteralPath $FullPath).GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access) } |
      ConvertTo-Json | Set-Content -LiteralPath $record -Encoding utf8
    Copy-Item -LiteralPath $PSCommandPath -Destination $restoreScript
    $command | Set-Content -LiteralPath ($backup + '.rollback.txt')
  }
  $script:recoveries.Add(@{ path = $FullPath; backup = $backup; record = $record; script = $restoreScript; command = $command; attempted = $false; restored = $false })
  Write-Report observation recovery $FullPath available 'These files can restore the saved DACL; no rollback has been executed.' $script:recoveries[-1]
  Write-Line ('BACKUP {0} -> {1}' -f $FullPath, $backup)
  Write-Line ('ROLLBACK {0}' -f $command)
}

function Restore-SavedDacl {
  param([string]$FullPath, [string]$Record, [string]$Root)
  $refusal = Get-RepairRefusal -FullPath $FullPath -Root $Root
  if ($refusal) { throw [System.ArgumentException]::new("RESTORE_REFUSED $refusal") }
  $saved = Invoke-ReportedOperation read_recovery $Record 'Read the recovery record and verify it belongs to the requested path before restoring its DACL.' none {
    Get-Content -LiteralPath $Record -Raw | ConvertFrom-Json
  }
  if ($saved.Path -isnot [string] -or $saved.Path -ine $FullPath -or $saved.Dacl -isnot [string]) {
    throw [System.ArgumentException]::new('RESTORE_REFUSED backup does not describe the requested path')
  }
  if (-not [Dsh.TokenInfo]::HasAccess($FullPath, 0x40000)) { throw 'RESTORE_REFUSED the caller lacks WRITE_DAC' }
  Invoke-ReportedOperation restore_dacl $FullPath 'Restore the requested backup DACL and inheritance protection, preserving owner and SACL.' acl {
    [Dsh.TokenInfo]::SetDacl($FullPath, $saved.Dacl)
  }
  $actual = Invoke-ReportedOperation read_restored_dacl $FullPath 'Read the restored DACL to compare it with the saved record.' none {
    (Get-Acl -LiteralPath $FullPath).GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access)
  }
  Write-Report verification restore $FullPath $(if ($actual -eq $saved.Dacl) { 'verified' } else { 'failed' }) 'Compare the observed DACL with the recovery record after writing it.' @{ expectedDacl = $saved.Dacl; actualDacl = $actual }
  if ($actual -ne $saved.Dacl) { throw 'RESTORE_FAILED the restored DACL differs from the backup' }
  $script:restored++
  Write-Line ('RESTORED {0}' -f $FullPath)
}

function Write-CompactSummary {
  param([string]$Status, [string]$NextAction, [array]$RollbackCommands)
  $byPath = [ordered]@{}
  foreach ($record in $script:reports) { if ($record.operation -eq 'inspect_acl') { $byPath[$record.path] = $record } }
  $observations = @($byPath.Values)
  $classifications = @($script:reports | Where-Object { $_.operation -eq 'classify' })
  $findings = @($observations | Where-Object {
    $_.path -in $script:requestedPaths -or $_.status -ne 'read' -or
    @($_.details['aces'] | Where-Object { $_ -and $_.sid -match $PACKAGE_SID -and $_.type -eq 'Allow' }).Count -gt 0
  } | ForEach-Object {
    @{ path = $_.path; status = $_.status; writeDac = $_.details['writeDac']; writeOwner = $_.details['writeOwner']
      packageAllowSids = @($_.details['aces'] | Where-Object { $_ -and $_.sid -match $PACKAGE_SID -and $_.type -eq 'Allow' } | ForEach-Object { $_.sid })
      denies = @($_.details['aces'] | Where-Object { $_ -and $_.type -eq 'Deny' }); errors = @($_.details['errors']; $_.details['error']) }
  })
  $details = [ordered]@{
    report = $script:reportPath; exitCode = $script:exitCode; nextAction = $NextAction
    inspectedPaths = @($observations | ForEach-Object { $_.path } | Select-Object -Unique)
    findings = $findings
    decisions = @($classifications | ForEach-Object { @{ path = $_.path; verdict = $_.status; reason = $_.reason; packageObjects = $_.details.packageObjects } })
    actions = @($script:reports | Where-Object { $_.kind -eq 'action' -and $_.details['effect'] -eq 'acl' -and $_.status -ne 'started' } | ForEach-Object { @{ operation = $_.operation; path = $_.path; status = $_.status; reason = $_.reason } })
    verification = @($script:reports | Where-Object { $_.kind -eq 'verification' } | ForEach-Object { @{ operation = $_.operation; path = $_.path; status = $_.status } })
    rollback = $script:rollbackStatus; rollbackCommands = $RollbackCommands
    errors = @($script:reports | Where-Object { $_.kind -eq 'error' -or ($_.kind -eq 'decision' -and $_.status -eq 'refused') } | ForEach-Object { @{ path = $_.path; reason = $_.reason; details = $_.details } })
  }
  $record = @{ kind = 'summary'; operation = $script:mode; path = $script:currentPath; status = $Status
    reason = 'Full observations, actions and reasons are in the report. Follow nextAction; a failed repair must not be followed by another repair.'; details = $details }
  [Console]::Out.WriteLine('REPORT ' + ($record | ConvertTo-Json -Depth 12 -Compress))
}

function Get-ObjectFacts {
  param([string]$FullPath, [string]$MeSid)
  $facts = [ordered]@{
    Object = $FullPath
    Readable = $false
    Error = ''
    PackageAces = @()
    OtherAppContainerSids = @()
    Owner = ''
    OwnerIsMe = $false
    MyRights = ''
    HasWriteDac = $null
    HasWriteOwner = $null
    Aces = @()
    Errors = @()
    LowLabel = $null
    AclLines = @()
  }
  try {
    # Get-Acl reads the security descriptor directly. On .NET Core the
    # FileSystemInfo.GetAccessControl() form is an extension method, which
    # PowerShell cannot invoke with instance syntax.
    $acl = Get-Acl -LiteralPath $FullPath
    $facts.Readable = $true
  } catch {
    $facts.Error = Get-HResultChain -Exception $_.Exception
    Write-Report observation inspect_acl $FullPath unreadable 'The ACL read failed; permissions and the cause of denial remain unknown.' @{ error = $facts.Error }
    return $facts
  }
  foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    $sid = $rule.IdentityReference.Value
    $facts.Aces += [ordered]@{
      sid = $sid; type = [string]$rule.AccessControlType; rights = [string]$rule.FileSystemRights
      inherited = $rule.IsInherited; inheritance = [string]$rule.InheritanceFlags; propagation = [string]$rule.PropagationFlags
    }
    if ($sid -match $PACKAGE_SID -and $rule.AccessControlType -eq 'Allow') {
      $facts.PackageAces += ('SID={0} INHERITED={1} INHERITABLE={2} RIGHTS={3}' -f $sid, $rule.IsInherited, $rule.InheritanceFlags, $rule.FileSystemRights)
    } elseif ($sid -match '^S-1-15-' -and $sid -notmatch $PACKAGE_SID) {
      $facts.OtherAppContainerSids += $sid
    }
    if ($sid -eq $MeSid -and $rule.AccessControlType -eq 'Allow') {
      $facts.MyRights = ($facts.MyRights + ';' + [string]$rule.FileSystemRights).Trim(';')
    }
  }
  try {
    $facts.Owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    $facts.OwnerIsMe = ($facts.Owner -eq $MeSid)
  } catch {
    $facts.Owner = 'unreadable'
    $facts.Errors += @{ operation = 'read_owner'; error = (Get-HResultChain $_.Exception) }
  }
  foreach ($check in @(@{ field = 'HasWriteDac'; mask = 0x40000 }, @{ field = 'HasWriteOwner'; mask = 0x80000 })) {
    try { $facts[$check.field] = [Dsh.TokenInfo]::HasAccess($FullPath, $check.mask) }
    catch { $facts.Errors += @{ operation = $check.field; error = (Get-HResultChain $_.Exception) } }
  }
  # The mandatory label lives in the SACL. Reading the SACL needs a privilege while
  # icacls prints the label without one, but icacls renders it by name, which is
  # localized: try the integrity SID first and keep the English name as a fallback.
  try {
    $facts.AclLines = @(icacls $FullPath 2>&1 | ForEach-Object { [string]$_ })
    if ($LASTEXITCODE -ne 0) { throw "icacls exit ${LASTEXITCODE}: $($facts.AclLines -join "`n")" }
    $text = $facts.AclLines -join "`n"
    # An unrecognized localized label is unknown, not evidence of a Low label.
    if ($text -match $LOW_LABEL_SID -or $text -match 'Mandatory Label\\Low Mandatory Level') { $facts.LowLabel = $true }
  } catch {
    $facts.Errors += @{ operation = 'icacls'; error = (Get-HResultChain $_.Exception) }
  }
  Write-Report observation inspect_acl $FullPath $(if ($facts.Errors.Count) { 'partial' } else { 'read' }) 'Read the ACL and check effective WRITE_DAC and WRITE_OWNER; observed ACEs alone do not identify which rule caused a denial.' @{
    owner = $facts.Owner; writeDac = $facts.HasWriteDac; writeOwner = $facts.HasWriteOwner
    aces = $facts.Aces; nativeListing = @($facts.AclLines | ForEach-Object { $_.Trim() } | Where-Object { $_ }); lowLabel = $facts.LowLabel; errors = $facts.Errors
  }
  return $facts
}

function Get-Ancestors {
  param([string]$FullPath)
  $list = @()
  $current = Get-NormalizedPath $FullPath
  while ($true) {
    $list += $current
    $parent = [System.IO.Path]::GetDirectoryName($current)
    if ([string]::IsNullOrEmpty($parent) -or $parent -eq $current) { break }
    $current = $parent
  }
  return $list
}

# --- main ---------------------------------------------------------------

$operations = [System.Collections.Generic.List[object]]::new()
$recoveries = [System.Collections.Generic.List[object]]::new()
$reports = [System.Collections.Generic.List[object]]::new()
$reportWriter = $null
$reportPath = $null
$reportFailed = $false
$requestedPaths = @()
$rollbackStatus = 'not-needed'
$fixed = 0
$granted = 0
$refused = 0
$restored = 0
$exitCode = 0
$observationFailures = 0
$currentPath = ''
$mode = if ($Restore) { 'restore' } elseif ($GrantFullControl) { 'grant' } elseif ($Fix) { 'fix' } else { 'diagnose' }

try {
  $requestedPaths = @($Path | ForEach-Object { [System.IO.Path]::GetFullPath($_) })
  Write-Report invocation $mode '' started 'Inspect the requested paths before deciding whether the requested operation can run.' @{
    paths = $Path; allowRoot = $AllowRoot; outputDirectory = $Out; recoveryRecord = $Restore; fix = $Fix.IsPresent; grantFullControl = $GrantFullControl.IsPresent
  }
  if ($Compact) {
    if (-not $Out) { throw [System.ArgumentException]::new('-Compact requires -Out for the complete report') }
    Invoke-ReportedOperation prepare_report $Out 'Create the requested report directory and a new JSONL report; existing reports are never overwritten.' files {
      $directory = [System.IO.Path]::GetFullPath($Out)
      [System.IO.Directory]::CreateDirectory($directory) | Out-Null
      $script:reportPath = Join-Path $directory ('acl-report-{0}.jsonl' -f [guid]::NewGuid().ToString('N'))
      $stream = [System.IO.File]::Open($script:reportPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write)
      $script:reportWriter = [System.IO.StreamWriter]::new($stream, [System.Text.UTF8Encoding]::new($false))
      foreach ($record in $script:reports) { $script:reportWriter.WriteLine(($record | ConvertTo-Json -Depth 12 -Compress)) }
    }
  }
  $identity = Get-CurrentIdentity
  $meSid = $identity.User.Value
  Invoke-ReportedOperation initialize '' 'Load read-only access checks and DACL-only writes before inspecting permissions.' none { Initialize-NativeApi }
  $integrity = Get-IntegritySid
  Write-Line ('CALLER SID={0} INTEGRITY={1}' -f $meSid, $integrity)
  Write-Report observation caller '' read 'The caller token determines effective access; unconfined execution does not imply elevation.' @{ sid = $meSid; integrity = $integrity }

  if (@(@($Fix.IsPresent, $GrantFullControl.IsPresent, [bool]$Restore) | Where-Object { $_ }).Count -gt 1) {
    throw [System.ArgumentException]::new('-Fix, -GrantFullControl and -Restore are separate operations; run one at a time')
  }
  if ($Fix -or $GrantFullControl -or $Restore) {
    $requiredArguments = if ($Restore) { @('AllowRoot') } else { @('AllowRoot', 'Out') }
    foreach ($required in $requiredArguments) {
      if (-not (Get-Variable -Name $required -ValueOnly)) {
        throw [System.ArgumentException]::new("The requested repair requires -$required")
      }
    }
    if ($Restore -and $Path.Count -ne 1) { throw [System.ArgumentException]::new('-Restore requires exactly one -Path') }
  }

  :paths foreach ($requested in $Path) {
    $currentPath = $requested
    $full = Get-NormalizedPath $requested
    $currentPath = $full
    Write-Line ('PATH={0}' -f $full)
    if (-not (Test-Path -LiteralPath $full)) {
      Write-Line '  MISSING'
      Write-Line 'VERDICT=NOT_THIS_CLASS'
      Write-Decision $mode $full skipped 'The requested path does not exist; no ACL was read or changed for it.'
      if ($mode -ne 'diagnose') { $refused++; break paths }
      continue
    }

    $packageTargets = @()
    $targetFacts = $null
    foreach ($ancestor in (Get-Ancestors -FullPath $full)) {
      if (-not (Test-Path -LiteralPath $ancestor)) { continue }
      $f = Get-ObjectFacts -FullPath $ancestor -MeSid $meSid
      if ($ancestor -eq $full) { $targetFacts = $f }
      Write-Line ('  OBJECT={0} READABLE={1}{2}' -f $f.Object, $f.Readable, $(if ($f.Readable) { '' } else { ' ERROR=' + $f.Error }))
      if ($f.Readable) {
        Write-Line ('    OWNER={0} IS_CURRENT_USER={1} MY_RIGHTS=[{2}] WRITE_DAC={3} WRITE_OWNER={4} LOW_LABEL={5}' -f $f.Owner, $f.OwnerIsMe, $f.MyRights, $f.HasWriteDac, $f.HasWriteOwner, $f.LowLabel)
        foreach ($ace in $f.PackageAces) { Write-Line ('    PACKAGE_ACE {0}' -f $ace) }
        foreach ($sid in ($f.OtherAppContainerSids | Sort-Object -Unique)) { Write-Line ('    OTHER_S1_15 SID={0} (reported only)' -f $sid) }
      }
      if ($f.PackageAces.Count -gt 0) { $packageTargets += $f }
    }

    # The precondition is judged on the requested path itself. Ancestors above the
    # tree DSH grants are not part of that grant, so their ownership and rights would
    # otherwise mark every healthy path as a precondition failure.
    if ($null -eq $targetFacts) { throw "The requested path disappeared before its ACL could be inspected: $full" }
    $unreadable = -not $targetFacts.Readable
    $needsPrecondition = (-not $unreadable) -and
      ((-not $targetFacts.HasWriteDac) -or (-not $targetFacts.HasWriteOwner))

    if ($targetFacts.Errors.Count -gt 0) {
      $verdict = 'INCOMPLETE'
      $reason = 'Some observations failed; missing evidence is not evidence that a right is absent or a repair is safe.'
    } elseif ($packageTargets.Count -gt 0) {
      $blocked = @($packageTargets | Where-Object { -not $_.HasWriteDac })
      $verdict = if ($needsPrecondition -or $blocked.Count -gt 0) { 'BOTH' } else { 'CULPRIT' }
      $reason = 'Package allow ACEs were observed. Required access checks determine whether the caller can perform the requested repair; other causes remain possible.'
    } elseif ($unreadable) {
      $verdict = 'UNREADABLE'
      $reason = 'The requested ACL could not be read; its entries and the cause of denial are unknown.'
    } elseif ($needsPrecondition) {
      $verdict = 'PRECONDITION'
      $reason = 'The caller cannot open the requested object with both WRITE_DAC and WRITE_OWNER. The reported allow and deny ACEs are evidence, not an attribution to one rule.'
    } else {
      $verdict = 'NOT_THIS_CLASS'
      $reason = 'No package allow ACE was observed and both required rights are available. Other ACL restrictions and causes of the original failure are not ruled out.'
    }
    Write-Line ('VERDICT={0}' -f $verdict)
    Write-Report decision classify $full $verdict $reason @{ writeDac = $targetFacts.HasWriteDac; writeOwner = $targetFacts.HasWriteOwner; packageObjects = @($packageTargets | ForEach-Object { $_.Object }) }

    if ($mode -eq 'diagnose') {
      Write-Decision diagnose $full skipped 'No mutation mode was requested; all reported ACLs were left unchanged.'
      continue
    }
    if ($targetFacts.Errors.Count -gt 0) {
      Write-Decision $mode $full refused 'Required observations are incomplete; no repair was attempted for this path.'
      $refused++; break paths
    }

    if ($Restore) {
      Restore-SavedDacl -FullPath $full -Record $Restore -Root $AllowRoot
      continue
    }

    if ($GrantFullControl) {
      if ($unreadable) { Write-Line 'GRANT_REFUSED the object could not be read; the grant needs an unconfined caller'; Write-Decision grant $full refused 'The ACL is unreadable, so a preserving grant cannot be constructed.'; $refused++; break paths }
      $refusal = Get-RepairRefusal -FullPath $full -Root $AllowRoot
      if ($refusal) { Write-Line ('GRANT_REFUSED {0}' -f $refusal); Write-Decision grant $full refused $refusal; $refused++; break paths }
      if ($targetFacts.HasWriteDac -and $targetFacts.HasWriteOwner) { Write-Line ('GRANT_SKIPPED {0} already carries WRITE_DAC and WRITE_OWNER' -f $full); Write-Decision grant $full skipped 'Effective WRITE_DAC and WRITE_OWNER are already available; no grant or backup is needed.'; continue }
      if (-not $targetFacts.HasWriteDac) { Write-Line 'GRANT_REFUSED the caller lacks WRITE_DAC; stop for permission-policy review'; Write-Decision grant $full refused 'Effective WRITE_DAC is absent; this caller cannot change the DACL. Stop for permission-policy review; do not elevate a writable script copy.'; $refused++; break paths }
      Save-AclBackup -FullPath $full -Directory $Out -Root $AllowRoot
      # AddAccessRule preserves explicit denies; icacls /grant can remove a deny
      # for the same principal. Write only the DACL, leaving owner and SACL intact.
      $grantAcl = Get-Acl -LiteralPath $full
      $grantAcl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
        [System.Security.Principal.SecurityIdentifier]::new($meSid),
        [System.Security.AccessControl.FileSystemRights]::FullControl,
        [System.Security.AccessControl.AccessControlType]::Allow))
      Invoke-ReportedOperation grant_dacl $full "WRITE_OWNER is missing and WRITE_DAC is available; add a FullControl allow ACE for $meSid while preserving deny ACEs, owner and SACL." acl {
        [Dsh.TokenInfo]::SetDacl($full, $grantAcl.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access))
      }
      $after = Get-ObjectFacts -FullPath $full -MeSid $meSid
      $verified = $after.Readable -and $after.Errors.Count -eq 0 -and $after.HasWriteDac -and $after.HasWriteOwner
      Write-Report verification grant $full $(if ($verified) { 'verified' } else { 'failed' }) 'The DACL write completed; recheck effective access before claiming that provisioning can succeed. On failure, restore this invocation and stop.' @{
        before = @{ writeDac = $targetFacts.HasWriteDac; writeOwner = $targetFacts.HasWriteOwner }
        after = @{ writeDac = $after.HasWriteDac; writeOwner = $after.HasWriteOwner }
        recovery = $recoveries[-1].command
      }
      if ($verified) {
        Write-Line ('GRANTED {0} SID={1}' -f $full, $meSid); $granted++
      } else {
        Write-Line ('GRANT_FAILED {0}; effective WRITE_DAC and WRITE_OWNER were not both confirmed; restore this invocation and stop' -f $full)
        $refused++
        break paths
      }
      continue
    }

    if (-not $Fix) { continue }

    if ($unreadable) {
      Write-Line 'FIX_REFUSED the object could not be read; repair needs an unconfined caller'
      Write-Decision fix $full refused 'The requested ACL could not be read; no package removal was attempted.'
      $refused++
      break paths
    }
    if ($packageTargets.Count -eq 0) { Write-Decision fix $full skipped 'No package allow ACE was observed on the inspected objects; no ACL change or backup is needed.' }
    $sources = @($packageTargets | Where-Object {
      @($_.Aces | Where-Object { $_.type -eq 'Allow' -and $_.sid -match $PACKAGE_SID -and -not $_.inherited }).Count -gt 0
    })
    [array]::Reverse($sources)
    foreach ($target in (@($sources) + @($packageTargets))) {
      $refusal = Get-RepairRefusal -FullPath $target.Object -Root $AllowRoot
      if ($refusal) { Write-Line ('FIX_REFUSED {0}' -f $refusal); Write-Decision fix $target.Object refused $refusal; $refused++; break paths }
      if ($target.Errors.Count -gt 0) { Write-Decision fix $target.Object refused 'The ACL observations are incomplete; collateral changes could not be verified.'; $refused++; break paths }
    }
    if ($packageTargets.Count -gt 0 -and $needsPrecondition) {
      Write-Decision fix $full refused 'Package removal requires verified WRITE_DAC and WRITE_OWNER on the requested path. A failed grant must not be followed by -Fix.'
      $refused++; break paths
    }
    foreach ($target in $sources) {
      if (-not $target.HasWriteDac) {
        Write-Line ('FIX_REFUSED {0} needs WRITE_DAC; stop for permission-policy review' -f $target.Object)
        Write-Decision fix $target.Object refused 'Effective WRITE_DAC is absent; removing a package allow ACE requires that right.'
        $refused++
        break paths
      }
    }
    Write-Report decision fix_sources $full selected 'Remove explicit package allow ACEs from their sources, ancestor first. Inherited entries are verified after source changes; inheritance stays enabled.' @{
      sources = @($sources | ForEach-Object { $_.Object }); affectedPaths = @($packageTargets | ForEach-Object { $_.Object })
    }
    foreach ($target in $sources) {
      Save-AclBackup -FullPath $target.Object -Directory $Out -Root $AllowRoot
      $sids = @($target.Aces | Where-Object { $_.type -eq 'Allow' -and $_.sid -match $PACKAGE_SID -and -not $_.inherited } | ForEach-Object { $_.sid } | Sort-Object -Unique)
      foreach ($sid in $sids) {
        $repairPath = $target.Object
        Invoke-ReportedOperation remove_package_allow $repairPath "Remove the observed package allow ACE for $sid as requested by -Fix; preserve deny ACEs and all other principals." acl {
          $output = @(icacls $repairPath /remove:g "*$sid" 2>&1)
          if ($LASTEXITCODE -ne 0) { throw "icacls removal exit ${LASTEXITCODE}: $($output -join "`n")" }
        }
      }
    }
    foreach ($target in $packageTargets) {
      $before = $target.AclLines
      $after = Get-ObjectFacts -FullPath $target.Object -MeSid $meSid
      # icacls prefixes only the first ACE with the path, so compare entries
      # without that prefix when checking for collateral changes.
      $keepBefore = @($before | ForEach-Object {
        $line = $_.Trim()
        if ($line.StartsWith($target.Object, [System.StringComparison]::OrdinalIgnoreCase)) { $line = $line.Substring($target.Object.Length).Trim() }
        $line
      } | Where-Object { $_ -notmatch $PACKAGE_SID })
      $keepAfter = @($after.AclLines | ForEach-Object {
        $line = $_.Trim()
        if ($line.StartsWith($target.Object, [System.StringComparison]::OrdinalIgnoreCase)) { $line = $line.Substring($target.Object.Length).Trim() }
        $line
      } | Where-Object { $_ -notmatch $PACKAGE_SID })
      # A package deny can share the removed allow's SID. Preserve it explicitly
      # even though native listing comparison omits lines naming package SIDs.
      $expectedAces = @($target.Aces | Where-Object { -not ($_.type -eq 'Allow' -and $_.sid -match $PACKAGE_SID) })
      $collateral = (($keepBefore -join "`n") -eq ($keepAfter -join "`n")) -and
        (($expectedAces | ConvertTo-Json -Compress) -eq ($after.Aces | ConvertTo-Json -Compress))
      $verified = $after.Readable -and $after.Errors.Count -eq 0 -and $after.PackageAces.Count -eq 0 -and $collateral
      Write-Report verification fix $target.Object $(if ($verified) { 'verified' } else { 'failed' }) 'The removal command completed; verify that package allow ACEs disappeared and other ACL listing entries remained unchanged. On failure, restore this invocation and stop.' @{
        remainingPackageAces = $after.PackageAces; otherEntriesUnchanged = $collateral
      }
      if ($verified) {
        $explicitSids = @($target.Aces | Where-Object { $_.type -eq 'Allow' -and $_.sid -match $PACKAGE_SID -and -not $_.inherited } | ForEach-Object { $_.sid } | Sort-Object -Unique)
        foreach ($sid in $explicitSids) { Write-Line ('FIXED {0} SID={1}' -f $target.Object, $sid); $fixed++ }
      } else {
        Write-Line ('FIX_FAILED {0} collateral_change={1}' -f $target.Object, (-not $collateral))
        $refused++
        break paths
      }
    }
  }
} catch {
  $exitCode = if ($_.Exception -is [System.ArgumentException]) { 2 } else { 1 }
  Write-Report error $mode $currentPath stopped 'Execution stopped after an exception. An interrupted write may have changed state; attempted repairs will be restored before the final summary.' @{ error = (Get-HResultChain $_.Exception); location = $_.InvocationInfo.PositionMessage }
} finally {
  if ($refused -gt 0 -and $exitCode -eq 0) { $exitCode = 2 }
  if ($exitCode -ne 0 -and -not $Restore) {
    for ($i = $recoveries.Count - 1; $i -ge 0; $i--) {
      $recovery = $recoveries[$i]
      if (-not $recovery.attempted) { continue }
      Write-Decision rollback $recovery.path selected 'The repair failed; restore every attempted DACL change from this invocation in reverse order before stopping.'
      try {
        Restore-SavedDacl -FullPath $recovery.path -Record $recovery.record -Root $AllowRoot
        $recovery.restored = $true
        $rollbackStatus = 'verified'
      } catch {
        $rollbackStatus = 'failed'
        Write-Report error rollback $recovery.path stopped 'Recovery was not verified. Stop repairs and retain the pending recovery commands in reverse order.' @{ error = (Get-HResultChain $_.Exception) }
        break
      }
    }
  }
  $pending = @($recoveries | Where-Object { $_.attempted -and -not $_.restored } | ForEach-Object { $_.command })
  [array]::Reverse($pending)
  $nextAction = if ($rollbackStatus -eq 'failed') { 'restore_pending_then_stop' } elseif ($exitCode -ne 0 -or $observationFailures -gt 0 -or $Restore) { 'stop' } elseif ($mode -eq 'diagnose') { 'review_findings' } else { 'verify_original_confined_operation' }
  Write-Line ('SUMMARY FIXED={0} GRANTED={1} REFUSED={2} RESTORED={3}' -f $fixed, $granted, $refused, $restored)
  $status = if ($exitCode -ne 0) { 'failed' } elseif ($observationFailures -gt 0) { 'partial' } else { 'completed' }
  Write-Report summary $mode $currentPath $status 'Operation completion records API execution; verification records the observed result. Only rerunning the original confined operation can confirm its failure is resolved.' @{
    exitCode = $exitCode; fixed = $fixed; granted = $granted; refused = $refused; restored = $restored
    operations = @($operations.ToArray()); recoveries = @($recoveries.ToArray()); automaticRollback = $true; observationFailures = $observationFailures
    rollback = $rollbackStatus; rollbackCommands = $pending; nextAction = $nextAction; report = $reportPath
  }
  if ($reportWriter) { $reportWriter.Dispose() }
  if ($Compact) { Write-CompactSummary -Status $status -NextAction $nextAction -RollbackCommands $pending }
}
exit $exitCode
