# Recording the README demo

The top of the main [README](../../README.md) embeds a short screen recording of `pnpm setup` → a grounded search. This directory is the toolkit for regenerating that recording when the UX changes.

## Prerequisites

```bash
brew install asciinema agg   # agg = asciinema → GIF/SVG converter
```

## Recording

1. Start from a clean clone (delete `.env`, clear Postgres, etc.) so the wizard walks through every prompt.
2. Run:
   ```bash
   asciinema rec --cols 100 --rows 28 -c 'bash docs/demo/record.sh' docs/demo/demo.cast
   ```
   The wrapper script pauses at key moments so the playback is readable. Press **Ctrl+D** when the wizard finishes.
3. Convert to SVG for GitHub rendering (GIF works too but the SVG stays crisp at any zoom):
   ```bash
   agg docs/demo/demo.cast docs/demo/demo.svg --theme monokai --speed 1.5
   ```
4. Upload the `.cast` file to [asciinema.org](https://asciinema.org) (`asciinema upload docs/demo/demo.cast`) if you want a click-to-play player embedded. Copy the resulting URL into the main README's `![demo]` placeholder.

## What the demo should show

In order, roughly 90 seconds total:

1. `pnpm install` (5s; fast-forwarded or cut)
2. `pnpm setup` prompts → answer a few interactively → validation pings light up green
3. Docker compose boots in the background (cut to the doctor checks going green)
4. The Google consent page opens in the browser (use a test account)
5. Wizard prints the `claude mcp add` command and offers to run it
6. A single curl to `/api/search?answer=true` returning a grounded answer with 2–3 cited emails

Trim the asciicast to ~60 seconds for the README embed. Keep a longer cut for a portfolio landing page if desired.
