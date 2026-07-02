# Configuration: every knob, in plain words

This page documents **every** setting Slate reads, so you never have to open the
code to learn how something works. Each knob is set as an environment variable,
usually through your `slate.env` file (copy it from `slate.env.example`). For
each one you get: **what it is**, **why it exists**, **where to get it**, and an
**example**.

Only one setting is truly required: `DISCORD_TOKEN`. Everything else turns a
feature on or off. When Slate starts it prints one line telling you the model it
uses, the backend it chose, and the channels it listens in, so you can confirm
your settings took.

The settings come in groups. Groups 1 to 7 are read by the bot itself
(`bot.mjs`). Groups 8 and 9 are read by the two optional helper Workers.

---

## 1. Discord

### `DISCORD_TOKEN` (required)
- **What:** the login token for your Discord bot.
- **Why:** without it Slate cannot connect to Discord at all. This is the one
  value Slate refuses to start without.
- **Where:** Discord Developer Portal -> your application -> **Bot** tab ->
  **Reset Token**. Copy it once; it is shown only that once.
- **Example:** `DISCORD_TOKEN=MTE1...your-long-token...abc`

### `DISCORD_CHANNEL_IDS`
- **What:** a comma-separated list of the Discord channel IDs Slate listens in.
- **Why:** it keeps Slate focused on the channels you want. If you leave it
  **empty**, Slate only replies to direct messages and to messages that
  @mention it.
- **Where:** in Discord, turn on **Developer Mode** (User Settings ->
  Advanced), then right-click a channel and choose **Copy Channel ID**.
- **Example:** `DISCORD_CHANNEL_IDS=123456789012345678,987654321098765432`

### `DISCORD_HISTORY`
- **What:** how many recent back-and-forth turns Slate keeps in the live
  conversation. Default `20`.
- **Why:** more history means Slate remembers more of the discussion, but each
  reply costs a little more. Twenty is a good balance.
- **Where:** you choose the number.
- **Example:** `DISCORD_HISTORY=20`

### `TRUSTED_BOT_IDS`
- **What:** a comma-separated list of other bot user IDs Slate is allowed to
  talk to.
- **Why:** by default Slate ignores messages from other bots (so bots do not
  talk in circles). List a bot here only if you run a second cooperating bot
  that should be able to reach Slate.
- **Where:** the other bot's user ID (Developer Mode -> right-click ->
  **Copy User ID**).
- **Example:** `TRUSTED_BOT_IDS=222333444555666777`

### `DISCORD_LOG`
- **What:** a file path Slate also writes its logs to. Optional.
- **Why:** handy if you want a log file on disk in addition to the screen.
  Leave it empty to log to the screen only. In the Docker stack this is set to
  `/dev/stdout` for you.
- **Where:** any writable path you choose.
- **Example:** `DISCORD_LOG=/var/log/slate.log`

---

## 2. The writing brain (Claude or Ollama)

Slate needs one language model to talk and to keep the storyboard. You pick one
of two paths. Set the Claude keys to use Claude; leave `CF_AIG_TOKEN` empty to
fall back to a local Ollama model.

### `DISCORD_MODEL`
- **What:** the model id Slate uses to think and write.
- **Why:** it names which model runs, on whichever path you chose.
- **Where:** for Claude, a Claude model id; for Ollama, the id of a model you
  have pulled locally.
- **Example (Claude):** `DISCORD_MODEL=claude-sonnet-4-6`
- **Example (Ollama):** `DISCORD_MODEL=qwen3.6:27b-ctx8k`

### `CF_AIG_TOKEN`
- **What:** a Cloudflare AI Gateway API token. This is the switch for the Claude
  path.
- **Why:** when set, Slate sends its thinking to Claude through your Cloudflare
  AI Gateway. When empty, Slate uses Ollama instead. The Gateway gives you
  logging, caching, and spend limits in one place.
- **Where:** Cloudflare dashboard -> **AI** -> **AI Gateway** -> your gateway ->
  **API keys**.
- **Example:** `CF_AIG_TOKEN=cf-aig-...`

### `CF_GATEWAY_ENDPOINT`
- **What:** your AI Gateway compatibility URL.
- **Why:** Slate uses it to find your gateway and reach Claude. It is required
  whenever `CF_AIG_TOKEN` is set.
- **Where:** the same AI Gateway page shows the endpoint URL. It ends in
  `/compat/chat/completions`.
- **Example:**
  `CF_GATEWAY_ENDPOINT=https://gateway.ai.cloudflare.com/v1/<account-id>/<gateway-name>/compat/chat/completions`

### `OLLAMA_BASE_URL`
- **What:** the address of your local Ollama server. Default
  `http://localhost:11434/v1`.
- **Why:** this is the fallback path when you do not set `CF_AIG_TOKEN`. It lets
  Slate run fully offline with no cloud model bill. (In Ollama mode, image
  attachments become a text note, since most Ollama models are text-only.)
- **Where:** wherever your Ollama runs; the default is an Ollama on the same
  machine.
- **Example:** `OLLAMA_BASE_URL=http://localhost:11434/v1`

---

## 3. The Studio (rendering)

Slate writes storyboards on its own. To turn one into a video it hands the job
to a Vivijure Studio.

### `VIVIJURE_API_URL`
- **What:** the web address of your Vivijure Studio (the control plane).
- **Why:** it is where Slate sends the finished storyboard when you run
  `!render`. Leave it empty and Slate still plans films, but `!render` has
  nowhere to go.
- **Where:** the hostname you deployed your Studio on (see the Studio's own
  quickstart).
- **Example:** `VIVIJURE_API_URL=https://vivijure.example.com`

### `STUDIO_API_TOKEN`
- **What:** the Studio's API token (a bearer token).
- **Why:** the Studio checks this token on every request Slate makes (storyboard
  bundle, cast sync, portrait upload, render submit, status). It is how Slate
  proves it is allowed to drive your Studio. **Required whenever
  `VIVIJURE_API_URL` is set** -- Slate refuses to start without it rather than
  fire calls that would be turned away.
- **Where:** your Studio prints (or lets you mint) this token when you deploy it;
  see the Studio's own quickstart. Paste the same value here.
- **Example:** `STUDIO_API_TOKEN=vjs_live_...`

### `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` (optional)
- **What:** a Cloudflare Access **service token** (an id and a secret).
- **Why:** optional, additive hardening. If you *also* put your Studio behind
  Cloudflare Access, these let Slate through that outer door; `STUDIO_API_TOKEN`
  above is still what the Studio itself checks. Leave both empty if your Studio
  has no Access in front of it (the common case).
- **Where:** Cloudflare **Zero Trust** -> **Access** -> **Service Auth** ->
  **Service Tokens** -> create one. Then add that token as an allowed client on
  your Studio's Access application.
- **Example:**
  `CF_ACCESS_CLIENT_ID=abc123.access`
  `CF_ACCESS_CLIENT_SECRET=long-secret-value`

---

## 4. Saved memory (Cloudflare D1)

D1 is a small cloud database. Slate uses it to remember every project's
storyboard, its conversation history, its undo history, and any pending render
jobs, so nothing is lost when the process restarts. Without these, Slate still
runs, but memory resets on restart.

Create a database once with `npx wrangler d1 create slate-sessions`; the command
prints the database id.

### `CF_D1_TOKEN`
- **What:** a Cloudflare API token with the **D1 Edit** permission.
- **Why:** it lets Slate read and write its database over Cloudflare's API.
- **Where:** dashboard -> **My Profile** -> **API Tokens** -> create a token
  with the D1 Edit permission.
- **Example:** `CF_D1_TOKEN=...`

### `CF_D1_ACCOUNT_ID`
- **What:** your Cloudflare account id.
- **Why:** it tells the API which account the database lives in.
- **Where:** dashboard, in the right sidebar of any of your zones.
- **Example:** `CF_D1_ACCOUNT_ID=0123456789abcdef0123456789abcdef`

### `CF_D1_DATABASE_ID`
- **What:** the id of the D1 database Slate uses.
- **Why:** it points Slate at the exact database to store sessions in.
- **Where:** printed when you ran `wrangler d1 create`, or in the dashboard
  under **Workers & Pages** -> **D1**.
- **Example:** `CF_D1_DATABASE_ID=00000000-1111-2222-3333-444455556666`

---

## 5. Pictures (the image generator)

### `LLM_API_URL`
- **What:** the base web address of the image service Slate calls for character
  portraits (`!portrait`) and scene thumbnails (`!thumbnail`). Default is our
  public playground.
- **Why:** it is where the picture generation happens. Portrait uploads flow
  through this service, which is why Slate itself needs no storage keys. Point
  it at your own image service if you run one.
- **Where:** the default works out of the box; change it only to use your own.
- **Example:** `LLM_API_URL=https://play.skyphusion.org`

---

## 6. Web search + knowledge base (optional)

These two settings switch on web search and the `!learn` knowledge base, both
served by the separate **slate-search** Worker (see group 8). Leave them
empty to run Slate without search.

### `SEARCH_WORKER_URL`
- **What:** the web address of your deployed slate-search Worker.
- **Why:** it is where Slate sends "look this up" and "search my knowledge base"
  requests. Empty means those powers are off.
- **Where:** the URL Cloudflare gives your deployed Worker.
- **Example:** `SEARCH_WORKER_URL=https://slate-search.example.workers.dev`

### `SEARCH_SECRET`
- **What:** a shared password Slate sends to the search Worker in the
  `X-Search-Secret` header.
- **Why:** it stops strangers from using your search Worker. It **must** match
  the `SEARCH_SECRET` you set on the Worker (group 8).
- **Where:** you invent it. Any long random string.
- **Example:** `SEARCH_SECRET=a-long-random-shared-string`

---

## 7. Shipping logs to a bucket (optional)

These switch on log shipping to the separate **slate-logs** Worker (see group
9), which stores logs in an R2 bucket. Leave them empty to keep logs on the
screen (and in `DISCORD_LOG`) only.

### `LOG_WORKER_URL`
- **What:** the web address of your deployed slate-logs Worker.
- **Why:** it is where Slate posts its log lines in batches. Empty means log
  shipping is off.
- **Where:** the URL Cloudflare gives your deployed Worker.
- **Example:** `LOG_WORKER_URL=https://slate-logs.example.workers.dev`

### `LOG_SECRET`
- **What:** a shared password Slate sends in the `X-Log-Secret` header.
- **Why:** it stops strangers from writing into your log bucket. It **must**
  match the `LOG_SECRET` set on the Worker (group 9).
- **Where:** you invent it. Any long random string.
- **Example:** `LOG_SECRET=another-long-random-string`

### `LOG_SERVICE`
- **What:** a label attached to each shipped log line. Default `slate`.
- **Why:** it lets one log bucket hold several services and still tell them
  apart.
- **Where:** you choose the label.
- **Example:** `LOG_SERVICE=slate`

---

## 8. The slate-search Worker (optional add-on)

This is a separate Cloudflare Worker in [search-worker/](../search-worker). It
gives Slate web search and a knowledge base. Its settings are Worker **secrets**,
set with `npx wrangler secret put <NAME>` from inside `search-worker/`, not in
`slate.env`. Its bindings (the AI model, the headless browser, and the Vectorize
index named `slate-knowledge`) live in `search-worker/wrangler.toml`.

### `BRAVE_API_KEY`
- **What:** an API key for Brave Search.
- **Why:** it powers plain web search.
- **Where:** brave.com/search/api.
- **Set with:** `npx wrangler secret put BRAVE_API_KEY`

### `TAVILY_API_KEY`
- **What:** an API key for Tavily, an AI-curated research search.
- **Why:** it powers the deeper "research" searches.
- **Where:** tavily.com.
- **Set with:** `npx wrangler secret put TAVILY_API_KEY`

### `SEARCH_SECRET`
- **What:** the shared password the Worker requires on incoming requests.
- **Why:** it must equal the bot's `SEARCH_SECRET` (group 6) so only your Slate
  can use the Worker.
- **Where:** the same value you put in `slate.env`.
- **Set with:** `npx wrangler secret put SEARCH_SECRET`

To create the knowledge-base index once, run
`npx wrangler vectorize create slate-knowledge --dimensions=1024 --metric=cosine`,
then `npm run deploy` from `search-worker/`.

---

## 9. The slate-logs Worker (optional add-on)

This is a separate Cloudflare Worker in [log-worker/](../log-worker). It receives
Slate's logs and stores them in an R2 bucket named `slate-logs` (set in
`log-worker/wrangler.toml`).

### `LOG_SECRET`
- **What:** the shared password the Worker requires on incoming log posts.
- **Why:** it must equal the bot's `LOG_SECRET` (group 7) so only your Slate can
  write logs.
- **Where:** the same value you put in `slate.env`.
- **Set with:** `npx wrangler secret put LOG_SECRET`

Create the bucket once with `npx wrangler r2 bucket create slate-logs`, then
`npm run deploy` from `log-worker/`.
