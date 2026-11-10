#!/usr/bin/env bash
set -eo pipefail

BOLD="\033[1m"
GREEN="\033[1;32m"
CYAN="\033[1;36m"
YELLOW="\033[1;33m"
RESET="\033[0m"

echo -e "${CYAN}┌─────────────────────────────────────────────────────────────┐${RESET}"
echo -e "${CYAN}│${RESET} ${BOLD}Installing hypr-harness (Spotlight & Quake Operator)${RESET}       ${CYAN}│${RESET}"
echo -e "${CYAN}└─────────────────────────────────────────────────────────────┘${RESET}"

SOURCE_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_CONFIG_DIR="$HOME/.config/hypr/harness"
BIN_DIR="$HOME/.local/bin"

# 1. Check prerequisites
echo -e "\n${BOLD}[1/4] Checking system prerequisites...${RESET}"
for cmd in bun kitty wofi; do
  if command -v "$cmd" &>/dev/null; then
    echo -e "  ✓ $cmd found"
  else
    echo -e "  ${YELLOW}! Warning: '$cmd' is not installed or not in PATH.${RESET}"
  fi
done

# 2. Deploy or link directory to ~/.config/hypr/harness
echo -e "\n${BOLD}[2/4] Setting up config destination (~/.config/hypr/harness)...${RESET}"
mkdir -p "$HOME/.config/hypr"
if [[ "$SOURCE_DIR" != "$TARGET_CONFIG_DIR" ]]; then
  if [[ -d "$TARGET_CONFIG_DIR" ]]; then
    echo -e "  Updating existing directory at $TARGET_CONFIG_DIR..."
    cp -r "$SOURCE_DIR"/* "$TARGET_CONFIG_DIR/"
  else
    echo -e "  Linking $SOURCE_DIR -> $TARGET_CONFIG_DIR..."
    ln -sfn "$SOURCE_DIR" "$TARGET_CONFIG_DIR"
  fi
else
  echo -e "  Repository is already located at $TARGET_CONFIG_DIR."
fi

# 3. Setup .env template if not present
echo -e "\n${BOLD}[3/4] Checking environment configuration (.env)...${RESET}"
ENV_FILE="$TARGET_CONFIG_DIR/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  if [[ -f "$TARGET_CONFIG_DIR/.env.example" ]]; then
    cp "$TARGET_CONFIG_DIR/.env.example" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    echo -e "  ${GREEN}Created $ENV_FILE from .env.example (permissions set to 600).${RESET}"
    echo -e "  ${YELLOW}→ Make sure to add your GEMINI_API_KEY in $ENV_FILE${RESET}"
  fi
else
  echo -e "  Existing .env detected."
fi

# 4. Symlink binaries into ~/.local/bin
echo -e "\n${BOLD}[4/4] Linking executable binaries to $BIN_DIR...${RESET}"
mkdir -p "$BIN_DIR"
for script in hypr-spotlight hypr-quake-toggle hypr-voice; do
  chmod +x "$TARGET_CONFIG_DIR/bin/$script"
  ln -sfn "$TARGET_CONFIG_DIR/bin/$script" "$BIN_DIR/$script"
  echo -e "  ${GREEN}✓ Linked $BIN_DIR/$script -> $TARGET_CONFIG_DIR/bin/$script${RESET}"
done

echo -e "\n${GREEN}${BOLD}Installation complete!${RESET}"
echo -e "Add the keybindings to your ${CYAN}~/.config/hypr/hyprland.lua${RESET} or ${CYAN}hyprland.conf${RESET}:"
echo -e "  ${YELLOW}SUPER + SPACE${RESET}       -> hypr-spotlight"
echo -e "  ${YELLOW}SUPER + SHIFT + SPACE${RESET} -> hypr-voice (push-to-talk / toggle voice input)"
echo -e "  ${YELLOW}SUPER + \`${RESET}           -> hypr-quake-toggle"
echo -e "Then reload with: ${BOLD}hyprctl reload${RESET}\n"
