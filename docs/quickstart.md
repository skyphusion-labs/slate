# Quick start: run your own Slate

This is the short path. Make a Discord bot, fill in your keys once, run one
command, and you have Slate writing films with you in your own Discord channel.
It takes a few steps, not a weekend.

New here? The one-page picture of how the parts fit together is in
[constellation.md](constellation.md). Slate is the box at the **top** of that
map: the Discord front door. It talks to a **Vivijure Studio**, which does the
actual rendering. You can run Slate on its own to write and plan; to turn a
storyboard into video you also need a Studio to point it at.

## Before you start

You need one thing for sure, and a few more to unlock everything:

- **Node 24 or newer** on your computer (get it at nodejs.org). Required.
- A **Discord bot**. Free. We make it in step 1.
- A **Cloudflare** account. Free to start. Used for the writing brain (Claude
  through AI Gateway) and for saved memory (D1). You can skip this at first and
  run on a local Ollama model instead.
- A **Vivijure Studio** address, if you want to render films. See the Studio's
  own quickstart to stand one up.

You do not need all of these to see Slate work. The only hard requirement is a
Discord bot token. Everything else adds a feature, and Slate tells you what is
off when it starts.

## Step 1: make a Discord bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
   and click **New Application**. Give it a name (like "Slate").
2. Open the **Bot** tab. Click **Reset Token** and copy the token. This is your
   `DISCORD_TOKEN`. Keep it secret.
3. Still on the **Bot** tab, scroll to **Privileged Gateway Intents** and turn
   **MESSAGE CONTENT** on. Slate cannot read your messages without this.
4. Open **OAuth2 -> URL Generator**. Under **scopes** check `bot` and
   `applications.commands`. Under **bot permissions** check **Send Messages**,
   **Read Message History**, and **Attach Files**.
5. Copy the URL it builds at the bottom, open it in your browser, and add the
   bot to your Discord server.

## Step 2: get the keys you will paste in

For the fullest experience Slate uses a handful of keys, each for **your own**
account. This page just names them; [configuration.md](configuration.md) says
exactly what each one is, why it exists, and where to click to get it.

- `DISCORD_TOKEN` (required) -- from step 1.
- `CF_AIG_TOKEN` + `CF_GATEWAY_ENDPOINT` -- to use **Claude** as the writing
  brain (recommended). Skip these to use a local **Ollama** model instead.
- `VIVIJURE_API_URL` + `STUDIO_API_TOKEN` -- your **Studio**, so Slate can render.
- `CF_D1_*` -- a small cloud database so Slate remembers your projects.
- `SEARCH_WORKER_URL` + `SEARCH_SECRET` -- optional web search + knowledge base.

## Step 3: the three commands

```bash
# 1. Make your key file from the example, then open it and fill in your keys.
cp slate.env.example slate.env

# 2. Edit slate.env. At minimum set DISCORD_TOKEN.

# 3. Run Slate. This is safe to re-run.
./run.sh
```

That is it. `run.sh` checks your keys, installs what it needs, and starts Slate.

> **Keep `slate.env` private.** It holds your keys. It is already set to be
> ignored by git, so it will not be committed. Never share it or paste it
> anywhere.

## What the script does for you

You do not run any of this by hand. `run.sh`:

1. Reads your `slate.env` and checks it. If `DISCORD_TOKEN` is missing, it
   **stops right there** and tells you, so Slate never starts half-configured.
2. Warns you (but keeps going) about any optional feature you left off, so you
   know what is on and what is not.
3. Checks you have Node 24 or newer.
4. Installs the code dependencies the first time (and skips that step on later
   runs).
5. Starts Slate. Press Ctrl-C to stop.

## Make your first film

In your Discord channel, just start talking about a film idea. Slate joins in
as a co-writer and quietly builds a storyboard in the background. Useful
commands:

- `!commands` -- see what is live on your studio (module-gated list).
- `!brief` -- show the storyboard so far.
- `!portrait A a weathered detective in a trench coat` -- draw a character.
- `!tier draft` and `!backend own-gpu` -- pick render settings (when modules are installed).
- `!preflight` -- validate before spending.
- `!render` -- when ready, Slate reads back settings, then ships on `ship it`.

The full command reference is in **[docs/commands.md](commands.md)** (every hook,
cast workflow, upload, and studio API route).

## Run it in Docker

Prefer containers? Slate ships a production Docker Compose stack in
[stacks/compose.prod.yml](../stacks/compose.prod.yml). Copy `slate.env.example`
to `stacks/.env`, fill it in, then:

```bash
docker compose -p slate -f stacks/compose.prod.yml up -d
```

Logs: `docker compose -p slate -f stacks/compose.prod.yml logs -f`.

## The two optional Workers

Two small Cloudflare Workers add extra powers. Neither is required.

- **slate-search** ([search-worker/](../search-worker)) -- web search
  (Brave, Tavily) plus a knowledge base you fill with `!learn`. Set
  `SEARCH_WORKER_URL` + `SEARCH_SECRET` to switch it on.
- **slate-logs** ([log-worker/](../log-worker)) -- ships Slate logs to an R2
  bucket. Set `LOG_WORKER_URL` + `LOG_SECRET` to switch it on.

Each has its own keys, listed in [configuration.md](configuration.md).

## If something goes wrong

- `run.sh` prints a clear error and stops. Read the last line; it names what is
  missing.
- Re-running is safe. Fix the value in `slate.env` and run `./run.sh` again.
- Slate logs one startup line telling you the model, the backend it chose
  (Claude or Ollama), and which channels it is listening in. If that line looks
  wrong, your keys are the place to look.
