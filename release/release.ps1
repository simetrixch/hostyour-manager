#!/usr/bin/env pwsh
# Starts the release kit's own script, the same file every consumer repository receives.
# It runs in a child pwsh so the exit code is the script's own.
# `& script.ps1` leaves $LASTEXITCODE at whatever the last native command inside the script set.
# Called that way, a release that succeeded would report a failure.
pwsh -NoProfile -File "$PSScriptRoot/../server/domains/units/release-kit/assets/release.ps1" @args
exit $LASTEXITCODE
