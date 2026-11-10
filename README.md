# hypr-harness (Hyprland Spotlight & Quake System Operator)

An intelligent, lightweight, zero-latency system operator command bar, push-to-talk voice agent, and slide-in continuous Quake console for Arch Linux and Hyprland, driven by Google Gemini (Gemini 3.5 Flash-Lite, 3.5 Flash, 3.8 Flash, and 3.1 Pro).

- **Spotlight Mode (`SUPER + SPACE`)**: Ephemeral floating pill search bar styled with `wofi`. Fast, one-off system operations, queries, and widget triggers.
- **Voice Input Mode (`SUPER + SHIFT + SPACE`)**: Push-to-talk speech operator with streaming Voice Activity Detection (VAD). Tap to start talking; auto-stops on silence (or manual re-press) and executes via Gemini multimodal transcription.
- **Quake Mode (`SUPER + \``)**: Slide-in dropdown continuous TUI console on a special workspace (`special:quake_operator`). Multi-turn conversations, live pop-up autocomplete for `/` commands and `@` file injections, inline output display, and autonomous self-healing execution loops.

---

## Key Features

### 1. Three Interaction Modes
- **Spotlight Pill (`SUPER + SPACE`)**:
  - Floating pill search bar styled with `wofi`.
  - Auto-dismisses on focus loss or ESC (`close_on_focus_loss=true`).
- **Push-to-Talk Voice (`SUPER + SHIFT + SPACE`)**:
  - Streams audio at 16kHz mono.
  - Dynamically calibrates ambient noise floor and auto-stops after 1.2s of silence.
  - Can also be manually cut off by tapping the keybind a second time.
- **Quake Dropdown (`SUPER + \``)**:
  - Slides in vertically on `special:quake_operator`.
  - Real-time interactive pop-up menus for slash commands (`/history`, `/model`, `/clear`, `/status`, `/help`, `/reset`, `/exit`) and `@` file references.
  - Seamless toggle: Pressing `SUPER + \`` opens or slides the console away.

### 2. File Reference Injection (`@file`)
- Type `@` anywhere in the console to trigger an interactive filesystem autocomplete menu.
- When submitted, the referenced file's contents are resolved and injected into Gemini's context window.

### 3. Dynamic Model Switcher (`/model`)
- Switch active Gemini models on the fly without restarting or editing configs:
  - `gemini-3.5-flash-lite`: Fast, lightweight system operator (Default)
  - `gemini-3.5-flash`: Balanced speed and multimodal reasoning
  - `gemini-3.8-flash`: High-performance fast generation
  - `gemini-3.1-pro-preview`: Deep reasoning and complex coding
- Available via `/model` inside Quake (with interactive `fzf` picker) or `model` in Spotlight (with clean 2-column GTK table).

### 4. Autonomous Multi-Turn Tool Loop & Self-Healing
- Executes safe read-only inspection commands (`grep`, `cat`, `hyprctl`, `pacman -Q`, `systemctl status`) across up to 8 reasoning iterations.
- If an executed command fails in the Quake dropdown, the exit code and stderr are fed back into Gemini for automatic error diagnosis and self-healing.

### 5. Dynamic Output Routing & Safety
- **Inline Console Output**: Standard shell command outputs (`df`, `free`, `uptime`, `ip a`, etc.) render cleanly inside the console.
- **Floating Inspector Cards**: Tabular data, long outputs (> 25 lines), or explicit visual guides open in a centered floating Kitty window (`hypr-harness-floating`).
- **Native GUI Dialogs**: Spawns Wayland-native GTK dialogs via `yad` for visual forms and graphs without blocking or escaping bugs.
- **Safety Intercepts**: Protects against process flooding (loops spawning multiple windows/apps), fork bombs, or destructive deletions with interactive confirmation barriers.

### 6. Tiered & Synchronized Memory
- **Rolling Context Buffer**: Retains conversation turns in `/tmp/hypr-spotlight.buffer.json` (auto-expires after 15 minutes of inactivity).
- **Cross-Interface Sync**: Any query or action performed in Spotlight or Voice is immediately synchronized into the Quake dropdown session on the next prompt.
- **Persistent Disk Audit Log**: Appends all past prompts and outcomes as JSON Lines to `~/.local/share/hypr-spotlight/history.jsonl`.

---

## System Prerequisites

- **OS**: Arch Linux (or any Linux distribution running Hyprland under Wayland)
- **Compositor**: Hyprland (0.57+ with `hyprland.lua` or legacy `hyprland.conf`)
- **Runtime**: [Bun](https://bun.sh/) (v1.2+)
- **Terminal**: `kitty`
- **Recommended Utilities**:
  - `ffmpeg` (for voice capture & silence detection)
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
│   ├── hypr-quake-toggle    # Quake slide-in dropdown toggle script
│   └── hypr-voice           # Push-to-talk voice recording & submission script
├── ui/
│   ├── style.css            # Dark pill floating CSS theme for wofi
│   └── wofi.conf            # Dynamic line configuration & window geometry
├── agent.ts                 # Gemini client, tool definitions & inspection loop
├── cli.ts                   # Spotlight CLI coordinator, session history & model switcher
├── quake_console.ts         # Quake TUI console, popup autocomplete & self-healing
├── vad_record.ts            # Voice Activity Detection streaming recorder
├── voice.ts                 # Multimodal audio transcription client
├── executor.ts              # Command runner, notification dispatcher & safety intercepts
├── config.ts                # Dynamic model configuration & API key resolver
├── history.ts               # Rolling buffer and persistent SQLite/JSONL history handlers
├── install.sh               # One-step automated installer
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
- Checks system dependencies (`bun`, `kitty`, `wofi`, `ffmpeg`).
- Links the repository into `~/.config/hypr/harness`.
- Generates a secure `~/.config/hypr/harness/.env` (mode `600`) if not already present.
- Links `hypr-spotlight`, `hypr-quake-toggle`, and `hypr-voice` into `~/.local/bin/`.

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
hl.bind(mainMod .. " + SHIFT + SPACE", hl.dsp.exec_cmd("~/.local/bin/hypr-voice"))
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
bind = SUPER SHIFT, SPACE, exec, ~/.local/bin/hypr-voice
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
   - `model` -> Opens an interactive GTK table to pick the active Gemini model.
   - `history pacman` -> Shows past package commands run through the harness.
2. **Push-to-Talk Voice (`SUPER + SHIFT + SPACE`)**:
   - Tap once and speak naturally (e.g. *"Show my memory usage"*). It auto-detects when you finish speaking and executes immediately.
   - Or tap again to manually submit right away.
3. **Quake Dropdown Console (`SUPER + \``)**:
   - Type `/` for a live command dropdown (`/history`, `/model`, `/clear`, `/status`, `/help`, `/reset`, `/exit`).
   - Type `@` to autocomplete files and inject their contents directly into your query.
   - Run multi-step tasks continuously without opening extra windows.
   - If an error occurs, the console displays the failure and automatically retries with corrected logic.

---

## License

DO WHAT THE FUCK YOU WANT TO PUBLIC LICENSE (WTFPL). See [LICENSE](LICENSE) for details.
