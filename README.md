# hypr-harness (Hyprland Spotlight System Operator)

An intelligent, lightweight, zero-latency system operator command bar for Arch Linux and Hyprland, driven by Google Gemini 3.5 Flash-Lite.

Triggered globally via `SUPER + SPACE`, `hypr-harness` captures user prompts, inspects the live operating system state via an autonomous multi-step reasoning tool loop, executes maintenance and inspection routines, presents on-demand interactive GTK/TUI wizards, and renders rich output via desktop notifications or ephemeral floating cards.

---

## Key Features

- **Sub-100ms Command Bar UI**:
  - Self-contained floating pill search bar styled with `wofi`.
  - Zero-line dynamic container layout (collapses to an input box until options or completions appear).
  - Dismisses immediately when clicking outside or pressing `ESC` (`close_on_focus_loss=true`).
- **Autonomous Multi-Turn Tool Loop**:
  - Instead of guessing or hallucinating commands, the engine autonomously executes read-only inspection commands (`grep`, `cat`, `hyprctl`, `pacman -Q`, `systemctl status`) across up to 8 reasoning iterations.
  - Automatically targets and parses both `~/.config/hypr/hyprland.lua` and `hyprland.conf`.
- **On-Demand Interactive Wizards (`prompt_wizard`)**:
  - When a workflow has multiple valid approaches, missing dependencies, or requires user choice, the engine dynamically instantiates an interactive dialog window (powered by `yad` for GTK or `fzf` in Kitty) to solicit input, and then re-enters the execution chain with your decision.
- **Tiered Memory System**:
  - **In-Memory Rolling Buffer**: Retains the last 6 conversation turns in `/tmp/hypr-spotlight.buffer.json` (auto-expires after 15 minutes of inactivity) to resolve follow-up requests and multi-step tasks.
  - **Persistent Disk Audit Log**: Appends all past prompts and outcomes as JSON Lines to `~/.local/share/hypr-spotlight/history.jsonl` (queryable directly from Spotlight with `history <keyword>`).
- **Dynamic Output Routing**:
  - **Quick Answers / Notifications**: Single-line confirmations pipe directly into `notify-send -a "spotlight"`.
  - **System Inspector Cards**: Tabular data, logs, or multi-line responses automatically render in a centered, floating Kitty card window (`hypr-harness-floating`) with syntax highlights that auto-closes on keypress.
  - **Native GUI Dialogs**: Capable of spawning GTK dialogs via `yad` for visual forms and text display.
  - **Destructive Command Safety**: Prompts for confirmation before executing file-modifying, package-deleting, or daemon-restarting commands.

---

## System Prerequisites

- **OS**: Arch Linux (or any Linux distribution running Hyprland under Wayland)
- **Compositor**: Hyprland (0.57+ with `hyprland.lua` or legacy `hyprland.conf`)
- **Runtime**: [Bun](https://bun.sh/) (tested on v1.2+)
- **Terminal**: `kitty`
- **Recommended Utilities**:
  - `wofi` (used for the command bar UI)
  - `yad` (for native GTK wizard and form dialogs)
  - `fzf` (for terminal wizard fallbacks)
  - `libnotify` (`notify-send` for desktop alerts)

---

## Repository Structure

```text
~/.config/hypr/harness/
├── bin/
│   └── hypr-spotlight       # Executable launcher script (invoked by Hyprland)
├── ui/
│   ├── style.css            # Dark pill floating CSS theme for wofi
│   └── wofi.conf            # Dynamic line configuration & window geometry
├── agent.ts                 # Gemini 3.5 Flash-Lite client, tool definitions & inspection loop
├── cli.ts                   # Core CLI coordinator, session history & wizard runner
├── config.ts                # Configuration loader and dynamic path resolution
├── dispatcher.ts            # Entrypoint forwarding module
├── executor.ts              # Command runner, notification dispatcher & floating window manager
├── history.ts               # Rolling buffer and persistent SQLite/JSONL history handlers
├── .env.example             # Example environment configuration
├── LICENSE                  # WTFPL License
└── README.md
```

---

## Setup & Installation

### 1. Clone the Repository
```bash
git clone https://github.com/<your-user>/hypr-harness.git ~/.config/hypr/harness
cd ~/.config/hypr/harness
```

### 2. Configure Your API Key
Copy `.env.example` to `.env` and set your Google Gemini API key:
```bash
cp .env.example .env
chmod 600 .env
```
Edit `.env`:
```ini
GEMINI_API_KEY=AIzaSy...your_gemini_api_key_here
```

### 3. Link the Launcher Binary
Link the launcher script into your `PATH` (e.g. `~/.local/bin`):
```bash
ln -sf ~/.config/hypr/harness/bin/hypr-spotlight ~/.local/bin/hypr-spotlight
chmod +x ~/.local/bin/hypr-spotlight
```

### 4. Configure Hyprland

#### For Hyprland Lua (`~/.config/hypr/hyprland.lua`):
```lua
-- Window rule for ephemeral spotlight floating inspectors and widgets
hl.window_rule({
    name = "hypr-spotlight-floating",
    match = { class = "hypr-harness-floating" },
    float = true,
    center = true,
    size = "700 450",
    focus_on_activate = true,
})

-- Global trigger shortcut
hl.bind("SUPER + SPACE", hl.dsp.exec_cmd("~/.local/bin/hypr-spotlight"))
```

#### For Legacy Hyprland Config (`~/.config/hypr/hyprland.conf`):
```ini
windowrule {
    name = hypr-spotlight-floating
    match:class = hypr-harness-floating
    float = yes
    center = yes
    size = 700 450
    focus_on_activate = true
}

bind = SUPER, SPACE, exec, ~/.local/bin/hypr-spotlight
```

Reload Hyprland:
```bash
hyprctl reload
```

---

## How to Operate

1. **Trigger the Bar**: Press `SUPER + SPACE`.
2. **Natural Language Queries**:
   - `check disk utilization` -> Pops up an ephemeral floating table with `df -h`.
   - `what screenshot keys are bound?` -> Autonomously inspects your `hyprland.lua` and summarizes all bindings.
   - `display my running processes in a pretty printed tree` -> Inspects available tools (`pstree`), checks flags, and spawns the visual tree.
   - `history pacman` -> Instantly displays previous pacman operations run through the harness.
   - `clear history` or `reset` -> Clears the rolling conversation buffer for a fresh session.

---

## License

DO WHAT THE FUCK YOU WANT TO PUBLIC LICENSE (WTFPL). See [LICENSE](LICENSE) for details.
