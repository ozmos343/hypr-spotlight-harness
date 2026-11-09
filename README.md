# hypr-harness (Hyprland Spotlight)

A lightweight, zero-latency system operator harness for Arch Linux & Hyprland driven by Gemini Flash-Lite.

Acts like an intelligent command bar (Spotlight / Raycast) triggered via `SUPER + SPACE`. It captures natural language prompts, coordinates local system inspections and administration, and displays output via desktop notifications or ephemeral floating terminal cards.

## Features
- **High-Speed Execution**: Powered by Bun and Google Gemini 3.5 Flash-Lite.
- **Local Inspection Loop**: Safely runs read-only commands (`grep`, `cat`, `hyprctl`, `pacman`) to inspect your real configuration before formulating accurate answers.
- **Tiered Memory**:
  - In-memory rolling buffer for multi-turn follow-ups.
  - Persistent disk log (`history.jsonl`) searchable via `history <keyword>`.
- **Ephemeral UI**:
  - Short one-liners pipe into clean desktop notifications.
  - Multi-line / structured tables automatically pop up in a centered floating window (`hypr-harness-floating`) that auto-closes on keypress.

## Setup & Configuration

1. Clone or copy into `~/.config/hypr/harness`:
   ```bash
   cp .env.example .env
   ```
2. Edit `.env` and set your API key:
   ```ini
   GEMINI_API_KEY=your_gemini_api_key_here
   ```
3. Add the keybinding and window rules to `~/.config/hypr/hyprland.conf`:
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

## License
MIT
