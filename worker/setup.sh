#!/bin/bash
# Defines what goes into the worker image. scripts/build-snapshot.mjs runs this
# inside a Box and then takes a snapshot of the result.
#
# Three of these lines are not optional for this factory, and each one is
# here because something in the app repos needed it — the build log is the only
# record of why:
#
#   Node 24   MOT1209/KingAgent declares engines.node >= 24.0.0. A Box that
#             answers `npm ci` with a warning and a test suite full of syntax
#             errors is a wasted smoke test and a wasted Box.
#   zsh       tests/run-done.test.mjs, tests/platform.test.mjs and
#             tests/agents-detect.test.mjs exercise zsh-backed behaviour, which
#             is exactly why the repo's own CI does `apt-get install -y zsh` on
#             Ubuntu before it runs the suite.
#   opencode  not in the stock Box.
#
# Facts about a Box: Debian 12 on ARM64, user "boxuser" with passwordless sudo,
# Node, git, Claude Code and Codex already installed.
set -euo pipefail

# --- Node 24 ---------------------------------------------------------------
# The Box image ships Node, but not necessarily the major these repos pin. Put
# 24 on PATH for every later command, including the ones that only read
# /etc/profile.d — build-snapshot.mjs runs setup as a login script, so this is
# inherited by setup, the smoke test and every job started from the image.
sudo apt-get update -qq
sudo apt-get install -y -qq --no-install-recommends ca-certificates curl xz-utils zsh > /dev/null
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - > /dev/null
sudo apt-get install -y -qq --no-install-recommends nodejs > /dev/null
sudo tee /etc/profile.d/node24.sh > /dev/null <<'PROFILE'
export PATH=/usr/bin:$PATH
PROFILE

# profile.d only reaches the NEXT login shell, and the shell running this
# script started before the file existed. So put it in front now, or the check
# at the end proves the stock Node instead of the one just installed.
export PATH=/usr/bin:$PATH

# --- Agent CLIs the stock Box lacks ---------------------------------------
# ARM64 matters: a CLI without a linux-arm64 build cannot be installed here at
# all, and the smoke test is what proves it before a worker is provisioned.
sudo npm install --global --silent opencode-ai

# --- Check -------------------------------------------------------------------
# The build must fail when something is missing, so every tool a worker relies
# on is asserted here rather than discovered in production.
echo "--- check"
node --version
git --version
zsh --version
claude --version
codex --version
opencode --version
# Both app repos declare engines.node, so prove the major they ask for:
node -e "const major=Number(process.versions.node.split('.')[0]); if (major < 24) { console.error('Node ' + process.versions.node + ' is too old for the app repos'); process.exit(1); } console.log('node major ' + major + ' ok')"
