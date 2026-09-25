#!/usr/bin/env bash
# Starts the release kit's own script, the same file every consumer repository receives.
exec bash "$(dirname "$0")/../plugins/unit/server/release-kit/assets/release.sh" "$@"
