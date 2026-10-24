@echo off
rem Windows shim for the fake Codex CLI.
rem The committed FIX tests spawn fake-codex.mjs through node directly
rem (see tests/support/fake-seam.mjs): a .cmd shim makes argv quoting and process
rem termination platform-dependent. This shim is only for manual experiments.
node "%~dp0fake-codex.mjs" %*
