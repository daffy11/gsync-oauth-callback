# GSync Limited 0.2.0 (experimental)

A separate, unverified Obsidian community plugin prototype with Google Drive `drive.file` access and an optional limited-scope Google OnePick login. It is **not** the official GSync.

**Do not use on your primary vault without full backups.** Google Advanced Protection authentication and iPhone real-world synchronization have not been verified.

Features: first-sync authority selection (Drive/local/both/skip), per-folder conflict rules, preview-and-confirm, local backups before overwrite, no deletion, no automatic sync by default, external modification detection for visible files. Google `drive.file` does **not** guarantee that selecting a folder grants access to every file subsequently added by other apps.

The OAuth callback is hosted at https://daffy11.github.io/gsync-oauth-callback/limited-callback.html and exchanges the code using the Obsidian app protocol.

## iPhone installation
Use the Obsidian BRAT plugin, then add this public GitHub repository `daffy11/gsync-oauth-callback` after the release is published. BRAT requires release assets `main.js` and `manifest.json`.

## Important
This repository also hosts the user's existing static OAuth callback page. Plugin artifacts do not modify the original `callback.html`. No OAuth secret or refresh token belongs in the repository.

Source base: [dg0988/ObsidianGSync](https://github.com/dg0988/ObsidianGSync), MIT license.

Release asset integrity: SHA256 of `main.js` = `dff892b1898b48d8cfa21fdb4f8fa38ef3ab5f96928aa86fe46e111b7cdbdcf3`.
