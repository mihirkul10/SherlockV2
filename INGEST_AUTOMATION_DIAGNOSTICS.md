# YouTube Ingestion Automation - Diagnostics Report

**Automation**: `.cursor/automations/ingest-youtube.md`  
**Run Date**: 2026-06-05 21:31 UTC  
**Status**: ❌ FAILED - Blocking Issue on Step 0

## Issue Summary

The YouTube ingestion automation cannot complete Step 0 due to authentication failure when attempting to clone the `sherlock-context` repository.

### Root Cause
The `SHERLOCK_GITHUB_PAT` secret is invalid or expired. GitHub rejects it with:
```
remote: Invalid username or token. Password authentication is not supported for Git operations.
```

## Detailed Findings

### 1. Environment Variables ✓
All required environment variables are injected:
- ✓ `YOUTUBE_API_KEY` - present
- ✓ `APIFY_API_TOKEN` - present  
- ✓ `SHERLOCK_GITHUB_PAT` - present (but **invalid**)
- ✓ `SHERLOCK_CONTEXT_PATH` - present

### 2. Repository Access ❌
Attempted to clone `https://github.com/mihirkul10/sherlock-context.git`:
- Direct git clone with SHERLOCK_GITHUB_PAT: **FAILED** - "Invalid username or token"
- gh CLI clone: **FAILED** - "Repository not found"
- This suggests either:
  - The repository doesn't exist or is deleted
  - The repository is under a different owner/organization
  - The SHERLOCK_GITHUB_PAT has insufficient permissions

### 3. Dependencies ✓
- npm install: **SUCCESS**
- Node.js 22.x: **AVAILABLE**
- Git 2.39.5: **AVAILABLE**
- Required tools: **ALL AVAILABLE**

### 4. Repo Structure
The `sherlock-context` path exists with:
- `_runs/` directory present
- Missing: `_state/sources.json` (required by the ingest script)
- Missing: `_raw/youtube/` (target for ingest output)

### 5. Script Status
Ran `npm run ingest -- youtube` to validate downstream:
```
Exit code: 1 (fatal error)
Error: "/sherlock-context/_state/sources.json not found. Run M0g (seed-sources) first."
```

This confirms:
1. Dependencies are satisfied
2. The script would run IF sources.json existed
3. The failure is purely due to missing sherlock-context repository clone

## Required Actions

To resolve this blocking issue, one of the following is needed:

### Option A: Fix the SHERLOCK_GITHUB_PAT secret
1. Verify the PAT in Cursor Dashboard > Cloud Agents > Secrets
2. Ensure the PAT:
   - Is not expired
   - Was not revoked
   - Has `repo` scope (at minimum: `public_repo` and if private, full `repo` scope)
   - Is for the correct GitHub account (mihirkul10)
3. Update the secret if invalid

### Option B: Use GitHub App or OAuth token
If personal access tokens are problematic, consider:
- Using a GitHub App installation token
- Switching to OAuth credentials
- Creating a machine user PAT with explicit repo permissions

### Option C: Verify repository accessibility
1. Confirm `mihirkul10/sherlock-context` exists and is not deleted
2. Verify PAT user (usually the same as creating account) has access
3. Check if repository was moved or renamed

## Testing Performed

```bash
# ✓ npm install --no-audit --no-fund
# ✓ Environment variable checks
# ❌ git clone with SHERLOCK_GITHUB_PAT
# ❌ gh repo clone
# ✓ npm run ingest -- youtube (downstream validation)
```

## Next Steps

Once the SHERLOCK_GITHUB_PAT is fixed or replaced:
1. Re-run automation
2. Step 0 should complete: clone + configure git identity
3. Step 1: `npm run ingest -- youtube` will fetch videos from configured sources
4. Step 2: Validate exit code and new files
5. Step 3: Commit and push to sherlock-context

---

**Automation file reference**: `.cursor/automations/ingest-youtube.md`  
**Documentation**: `README.md` (Three-repo layout section)
