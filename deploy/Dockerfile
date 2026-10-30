# Pokémon Matrix Widget: the widget page, the API and the WebSocket in one Node process.
#
#   docker build -f deploy/Dockerfile -t pokemon-widget .
#   docker build -f deploy/Dockerfile --build-arg FETCH_SPRITES=1 -t pokemon-widget .   # bake in ~24 MB of sprites
#
# Sprites are not in the repository (they belong to Nintendo/Creatures/GAME FREAK; see README "Sprites").
# With FETCH_SPRITES=1 the image fetches them from PokeAPI/sprites at the pinned commit and serves them
# itself; without it the widget loads them from raw.githubusercontent.com, which is fine for a small group.
FROM node:24-alpine AS sprites
ARG FETCH_SPRITES=0
RUN mkdir -p /sprites
COPY scripts/fetch-sprites.sh /fetch-sprites.sh
RUN if [ "$FETCH_SPRITES" = "1" ]; then apk add --no-cache git && sh /fetch-sprites.sh /sprites; fi

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY shared ./shared
COPY web ./web
COPY --from=sprites /sprites /sprites
# web/shared is a symlink to ../shared in the repository; the server serves /shared/ from /app/shared
# directly, so the symlink is only needed by tests and is fine to copy as is.
ENV PORT=8090 HOST=0.0.0.0 DB_FILE=/data/pokemon.db
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8090/healthz || exit 1
# SPRITES_DIR is set only when the build fetched sprites (an empty folder would serve nothing).
CMD ["sh", "-c", "if [ -d /sprites/pokemon ]; then export SPRITES_DIR=/sprites; fi; exec node server/index.js"]
