#!/usr/bin/env bash
# ATerminal — First-Time Setup
# Run this once: bash setup.sh

set -e

# ANSI colour helpers
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
RED='\033[0;31m'
GRAY='\033[0;90m'
CYAN='\033[0;36m'
RESET='\033[0m'

echo ""
echo -e "  ⌨  ${CYAN}ATerminal${RESET}"
echo -e "  ${GRAY}Self-hosted remote terminal for phones and tablets${RESET}"
echo ""

# ── 1. Check Node.js ────────────────────────────────────────────────────────
echo -e "${YELLOW}[1/3] Checking Node.js...${RESET}"
if ! command -v node >/dev/null 2>&1; then
    echo -e "${RED}      Node.js not found.${RESET}"
    echo -e "${GRAY}      Download: https://nodejs.org/en/download${RESET}"
    exit 1
fi

NODE_VER=$(node --version)
NODE_MAJOR=$(node --version | sed 's/v//' | cut -d. -f1)

if [ "$NODE_MAJOR" -lt 22 ]; then
    echo -e "${RED}      Node.js 22 or newer is required. Found: ${NODE_VER}${RESET}"
    echo -e "${GRAY}      Download: https://nodejs.org/en/download${RESET}"
    exit 1
fi

echo -e "${GREEN}      Found ${NODE_VER}${RESET}"

# ── 2. Install dependencies ─────────────────────────────────────────────────
echo -e "${YELLOW}[2/3] Installing dependencies...${RESET}"
if ! npm install --silent 2>/dev/null; then
    echo -e "${RED}      npm install failed. Run 'npm install' manually to see errors.${RESET}"
    exit 1
fi
echo -e "${GREEN}      Done.${RESET}"

# ── 3. First-time config ─────────────────────────────────────────────────────
echo -e "${YELLOW}[3/3] Setting up ATerminal...${RESET}"
echo ""

# Start with --lan so the phone on the same WiFi can connect directly.
# On first run this prompts for a password then starts everything.
node --no-warnings=ExperimentalWarning bin/aterminal.js server setup --lan
