# Slate -- self-contained image for the Vivijure screenwriter Discord bot.
# Build:  docker build -t slate .
# Run:    docker run --rm --env-file stacks/.env slate
FROM node:24-slim

WORKDIR /app

# Install runtime deps first so the layer caches across source-only changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Application source (bot.mjs imports ./lib.mjs; assets/ is docs-only, not runtime).
COPY *.mjs ./

# Logs go to stdout in container mode.
ENV DISCORD_LOG=/dev/stdout

# Drop to the stock non-root user shipped in the node image.
USER node

CMD ["node", "bot.mjs"]
