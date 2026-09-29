---
name: diagnose-windows-sandbox-acl
description: 'Use on Windows for unexpected DSH sandbox access denials: workspace writes or listing fail, or an ordinarily readable path cannot be read. The bundled script inspects the path and every ancestor, reports observations and action reasons, and supports scoped, backed-up ACL repairs. Expected confinement denials need no ACL repair.'
---

# Diagnose Windows sandbox ACL failures

**Stop after any failed/refused repair or failed verification.** A completed DACL write is not a successful repair. Never continue from a failed grant to `-Fix`, repeat the grant, or remove a deny ACE. The script automatically restores attempted changes from the failed invocation; verify its rollback result. Restore earlier successful invocations in reverse order using their exact recovery commands, then stop. A later backup alone cannot undo earlier repairs.

## Decide whether diagnosis applies

Diagnose unexpected writes/listing denied inside a `workspace-write` workspace, or reads the signed-in user should plainly have. Root-only failure and uniform failure are both eligible.

Stop and explain expected denials: writes outside the workspace, any write in `read-only`, piped grandchild `spawn EPERM`, or ConstrainedLanguage errors for .NET/COM/reflection. Request an approval for the one call you still need; do not repair ACLs for these cases.

## Read the report before choosing a repair

Resolve the script from this skill's resource directory. Run it in the current sandbox first: classification completes under `workspace-write` with a writable `-Out` directory, while `read-only` cannot write one and refuses. When a denial or an unwritable report directory prevents the call, request one escalation of that same call through the normal approval path instead of assuming the diagnosis cannot run; if approval is refused, unavailable to the session, or forbidden by policy, report the path as undiagnosed and stop. Unconfined does not elevate the Windows token. Use one path per invocation; do not repeat `-Path` or pass a comma-separated string to `pwsh -File`.

```powershell
& '<skill-directory>\scripts\diagnose-windows-sandbox-acl.ps1' -Path '<failing-path>' -Out '<report-directory>' -Compact
exit $LASTEXITCODE
```

Substitute full, quoted paths. Choose a persistent, user-owned `-Out` directory, preferably beside the failing workspace within the authorized tree. Never put reports or backups in the skill resource directory: it is deleted when the skill unloads. `-Compact` saves a unique full JSONL report and prints one `REPORT` summary. Diagnosis changes no ACL or existing content; it only writes this requested report. The summary includes all `inspectedPaths`, findings, decisions, ACL actions, verification, rollback state and `nextAction`. Use the summary to decide; read only specific records from the saved report when evidence is missing, without dumping the whole report or reading the implementation to rediscover these instructions.

Each full record has `kind`, `operation`, `path`, `status`, `reason`, `details`. Unknown observations remain unknown. A deny ACE's presence alone does not establish causation. DSH provisions `S-1-4-*` workspace grants and an Everyone `DeleteSubdirectoriesAndFiles` deny; these are expected confinement entries, not package conflicts or automatically unresolved faults. Coexisting package ACEs may still block the confined child even when provisioning fails first; do not dismiss either finding. `completed` actions only confirm API execution. Check verification and the final summary. Missing summary means unconfirmed completion: inspect the report and recovery artifacts before doing anything else.

| Verdict | Next step, only with complete observations |
|---|---|
| `CULPRIT` | Explain the affected paths and individual package allow SIDs; select `-Fix`. |
| `PRECONDITION` | Explain missing effective `WRITE_DAC`/`WRITE_OWNER`; select `-GrantFullControl` if the caller has `WRITE_DAC`. |
| `BOTH` | Grant on the affected object first. Only after verified success may a separate invocation use `-Fix`. Failure ends this sequence. |
| `UNREADABLE`, `INCOMPLETE`, `NOT_THIS_CLASS` | Report observations and stop; do not infer a safe repair. |

## Run the selected repair

Explain the finding and cost first. `-Fix` removes individual `S-1-15-2-*` allow ACEs at their explicit sources, ancestor first, then verifies inherited entries disappeared; well-known groups ending in 1 or 2 are preserved. This removes those packages' access. `-GrantFullControl` adds a current-user allow ACE; it cannot cancel an explicit deny. Both preserve owner, inheritance and SACL, including Low integrity labels. Low executable labels and their effects outside DSH are outside this repair's scope. Full control supplies `WRITE_DAC` and `WRITE_OWNER`; taking ownership alone does not.

Append `-AllowRoot '<authorized-containing-directory>'` and **exactly one** of `-Fix` or `-GrantFullControl` to the diagnostic command, before `exit`. Keep `-Compact -Out`. Every explicit source must be strictly inside that root; reparse paths and managed application trees (`LocalAppData\Packages`, `ProgramFiles\WindowsApps`) are refused. Never widen the authorized root to reach an ancestor. Missing effective `WRITE_DAC` in the unconfined caller requires stopping and reporting the path and missing rights for permission-policy review. Extracted scripts and recovery copies are user-writable: never supply commands to run them elevated, initiate UAC/`runas`, or run the whole agent elevated.

Follow `nextAction`: `stop` ends repairs; `restore_pending_then_stop` requires the reported recovery commands in their listed order, then stop. Verified rollback does not turn a failed repair into success. Keep full report/backup paths and exact recovery commands for every invocation; never abbreviate executable paths. On recovery failure, stop and report the remaining commands without more repairs.

For `verify_original_confined_operation`, repeat the original failed operation in the original confined context. If it still fails, restore this workflow's successful repairs in reverse order, report the error and stop. Do not start another repair cycle.

Use the user's language for progress and final reporting. Concisely report observations and analyzed paths (including relevant ancestors), actions and reasons, verification, and the next step; link full reports. Label any authorized unconfined fallback as such, not as successful repair. Explain that another tool may recreate a removed package ACE. Never write probe files, edit ACLs by hand, change owners, erase denies, or replace child permissions recursively. Do not provide manual ACL-edit commands for the user either: only bundled repairs and generated recovery commands are supported; unresolved denies require permission-policy review or moving the workspace.
