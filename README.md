# hypr-harness (Hyprland Spotlight & Quake System Operator)

An intelligent, lightweight, zero-latency system operator command bar and slide-in continuous Quake console for Arch Linux and Hyprland, driven by Google Gemini 3.5 Flash-Lite.

- **Spotlight Mode (`SUPER + SPACE`)**: Ephemeral floating pill search bar styled with `wofi`. Fast, one-off system operations, queries, and widget triggers.
- **Quake Mode (`SUPER + \``)**: Slide-in dropdown continuous TUI console on a special workspace (`special:quake_operator`). Multi-turn conversations, GNU readline editing, `/` tab autocompletion, inline output display, and autonomous self-healing execution loops.

---

## Key Features

### 1. Dual Operational Interfaces
- **Spotlight Pill (`SUPER + SPACE`)**:
  - Floating pill search bar styled with `wofi`.
  - Auto-dismisses on focus loss or ESC (`close_on_focus_loss=true`).
- **Quake Dropdown (`SUPER + \``)**:
  - Dropdown console sliding in vertically on `special:quake_operator`.
  - GNU readline line editor with interactive history and slash command tab completion (`/history`, `/clear`, `/status`, `/help`, `/reset`, `/exit`).
  - Seamless toggle: Pressing `SUPER + \`` opens or slides the console away.

### 2. Autonomous Multi-Turn Tool Loop
- Executes safe read-only inspection commands (`grep`, `cat`, `hyprctl`, `pacman -Q`, `systemctl status`) across up to 8 reasoning iterations before finalizing answers.
- Automatically targets and parses both `~/.config/hypr/hyprland.lua` and legacy `hyprland.conf`.

### 3. Self-Healing & Error Recovery Loop
- Inside the Quake dropdown, if an executed shell command returns a non-zero exit code or stderr, the output is captured and immediately re-fed into Gemini's context window.
- The agent analyzes the syntax or runtime error, fixes the parameters, and re-executes the corrected version within its turn budget.

### 4. Dynamic Output & Display Routing
- **Inline Console Output**: Standard command outputs (`df`, `free`, `uptime`, `ip a`, etc.) render cleanly inside the Quake console without opening unnecessary windows.
- **Floating Inspector Cards**: Tabular data, long outputs (> 25 lines), or explicit visual guides open in a centered floating Kitty window (`hypr-harness-floating`) that auto-closes on keypress.
- **Native GUI Dialogs**: Spawns Wayland-native GTK dialogs via `yad` for visual forms and graphs without blocking or escaping bugs.
- **Safety & Process Flood Intercepts**: Protects against process flooding (e.g. loops spawning multiple background windows/apps like `xeyes`), fork bombs, or destructive deletions with interactive confirmation barriers.

### 5. Tiered & Synchronized Memory
- **Rolling Context Buffer**: Retains conversation turns in `/tmp/hypr-spotlight.buffer.json` (auto-expires after 15 minutes of inactivity).
- **Cross-Interface Sync**: Any query or action performed in Spotlight (`SUPER + SPACE`) is immediately synchronized into the Quake dropdown session on the next prompt.
- **Persistent Disk Audit Log**: Appends all past prompts and outcomes as JSON Lines to `~/.local/share/hypr-spotlight/history.jsonl` (queryable directly with `/history` or `history <keyword>`).

---

## System Prerequisites

- **OS**: Arch Linux (or any Linux distribution running Hyprland under Wayland)
- **Compositor**: Hyprland (0.57+ with `hyprland.lua` or legacy `hyprland.conf`)
- **Runtime**: [Bun](https://bun.sh/) (v1.2+)
- **Terminal**: `kitty`
- **Recommended Utilities**:
  - `wofi` (used for the Spotlight command bar UI)
  - `yad` (for native GTK wizard and form dialogs)
  - `fzf` (for terminal wizard fallbacks)
  - `libnotify` (`notify-send` for desktop alerts)

---

## Repository Structure

```text
~/.config/hypr/harness/
├── bin/
│   ├── hypr-spotlight       # Wofi Spotlight launcher script
│   └── hypr-quake-toggle    # Quake slide-in dropdown toggle script
├── ui/
│   ├── style.css            # Dark pill floating CSS theme for wofi
│   └── wofi.conf            # Dynamic line configuration & window geometry
├── agent.ts                 # Gemini 3.5 Flash-Lite client, tool definitions & inspection loop
├── cli.ts                   # Spotlight CLI coordinator, session history & wizard runner
├── quake_console.ts         # Quake TUI console, readline editing, tab completion & self-healing
├── executor.ts              # Command runner, notification dispatcher & safety intercepts
├── config.ts                # Configuration loader and dynamic path resolution
├── history.ts               # Rolling buffer and persistent SQLite/JSONL history handlers
├── package.json
├── tsconfig.json
├── .env.example             # Example environment configuration
├── LICENSE                  # WTFPL License
└── README.md
```

---

## Setup & Quickstart

### 1. One-Step Automated Install (Recommended)
You can clone the repository anywhere and run the installer:
```bash
git clone https://github.com/<your-user>/hypr-harness.git
cd hypr-harness
./install.sh
```
The installer automatically:
- Checks system dependencies (`bun`, `kitty`, `wofi`).
- Links the repository into `~/.config/hypr/harness`.
- Generates a secure `~/.config/hypr/harness/.env` (mode `600`) if not already present.
- Links `hypr-spotlight` and `hypr-quake-toggle` into `~/.local/bin/`.

### 2. Configure Your API Key
Edit `~/.config/hypr/harness/.env`:
```ini
GEMINI_API_KEY=AIzaSy...your_gemini_api_key_here
```

### 3. Configure Hyprland

#### Hyprland Lua (`~/.config/hypr/hyprland.lua`):
```lua
local mainMod = "SUPER"

-- Rules for floating cards and quake dropdown
hl.window_rule({
    name = "hypr-spotlight-floating",
    match = { class = "hypr-harness-floating" },
    float = true,
    center = true,
    size = "700 450",
    focus_on_activate = true,
})

hl.window_rule({
    name = "hypr-quake-operator-rule",
    match = { class = "hypr-quake-operator" },
    float = true,
    size = "1280 400",
    move = "0 30",
    focus_on_activate = true,
})

-- Animation curve for smooth slide-in
hl.animation({ leaf = "specialWorkspace", enabled = true, speed = 5, bezier = "overshot", style = "slidevert" })

-- Keybindings
hl.bind(mainMod .. " + SPACE", hl.dsp.exec_cmd("~/.local/bin/hypr-spotlight"))
hl.bind(mainMod .. " + grave", hl.dsp.exec_cmd("~/.local/bin/hypr-quake-toggle"))
```

#### Legacy Hyprland Config (`~/.config/hypr/hyprland.conf`):
```ini
windowrule {
    name = hypr-spotlight-floating
    match:class = hypr-harness-floating
    float = yes
    center = yes
    size = 700 450
    focus_on_activate = true
}

windowrule {
    name = hypr-quake-operator-rule
    match:class = hypr-quake-operator
    float = yes
    size = 1280 400
    move = 0 30
    focus_on_activate = true
}

animation = specialWorkspace, 1, 5, overshot, slidevert

bind = SUPER, SPACE, exec, ~/.local/bin/hypr-spotlight
bind = SUPER, grave, exec, ~/.local/bin/hypr-quake-toggle
```

Reload Hyprland:
```bash
hyprctl reload
```

---

## Operating Instructions

1. **Spotlight Launcher (`SUPER + SPACE`)**:
   - `check disk space` -> Opens an ephemeral floating card displaying `df -h`.
   - `inspect keybinds` -> Reads `hyprland.lua` and summarizes active shortcuts via notification.
   - `history pacman` -> Shows past package commands run through the harness.
2. **Quake Dropdown Console (`SUPER + \``)**:
   - Type `/` and press `<Tab>` for command completion (`/history`, `/clear`, `/status`, `/help`, `/reset`, `/exit`).
   - Run multi-step tasks continuously without opening extra windows.
   - If an error occurs, the console displays the failure and automatically retries with corrected logic.

---

## License

DO WHAT THE FUCK YOU WANT TO PUBLIC LICENSE (WTFPL). See [LICENSE](LICENSE) for details.
