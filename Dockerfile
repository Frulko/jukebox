# syntax=docker/dockerfile:1

# Node 22, and not 24.
#
# Node stopped publishing a linux-armv7l binary after 22, so 24 cannot run on a
# 32-bit Raspberry Pi at all. This project is meant to sit next to an iPod dock
# on exactly that hardware, so 22 LTS is the ceiling until armv7 stops
# mattering — which, for the machines people already own, is not soon.
#
# bookworm-slim rather than alpine: the official Node alpine images do not
# publish linux/arm/v7, so choosing them would quietly drop the platform this
# whole constraint exists to serve.
FROM node:22-bookworm-slim AS build

WORKDIR /app

# Manifests first, so a change to source code does not re-run the install. The
# lockfile is copied with them or `npm ci` refuses.
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/satellite/package.json apps/satellite/
COPY packages/api-types/package.json packages/api-types/
COPY packages/client-sdk/package.json packages/client-sdk/

RUN npm ci --workspaces --include-workspace-root

COPY . .

# The web app is the only thing that needs building; the server runs from its
# TypeScript sources under --experimental-strip-types.
RUN npm run build --workspace @jukebox/web


FROM node:22-bookworm-slim AS runtime

# ffmpeg is what makes conversion work, and its absence is a first-class state
# the server already reports — but a music server that cannot convert out of the
# box is a worse default than sixty megabytes. rclone comes too: it is the whole
# of the remote-source story and useless to install separately inside a
# container.
#
# ca-certificates is not optional. Without it every HTTPS call — podcast feeds,
# ListenBrainz, the plugin store — fails with an error that reads like a bug.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg rclone ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/apps/server ./apps/server
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/packages ./packages

# The music and the database are the two things worth keeping, so both are
# mount points rather than layers.
ENV JUKEBOX_DB=/data/library.db \
    JUKEBOX_PLUGINS=/data/plugins \
    PORT=8787
VOLUME ["/data", "/music"]
EXPOSE 8787

# Not root. The container writes to /data and reads /music, and neither needs
# more than the `node` user already has.
RUN mkdir -p /data /music && chown -R node:node /data
USER node

# The health endpoint stays open without credentials precisely so this works
# once the server has been claimed by an account.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--experimental-strip-types", "--no-warnings=ExperimentalWarning", "apps/server/src/serve.ts"]
