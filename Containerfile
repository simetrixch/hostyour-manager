# syntax=docker/dockerfile:1
#
# The Manager image. Multi-stage, rootless.
#
# The server runs under tsx (no JS emit — one source of truth, no build/runtime skew), so the
# runtime image ships the TypeScript source + tsconfig + the full node_modules (tsx is a
# dev-tier dependency that IS needed at run). Migrations resolve source-relative
# (import.meta.url), so COPY server/ carries them.
#
# DATA_DIR is the one mounted volume; it holds manager.db and the admin.sock (break-glass
# mint — the server binds it there and sets its mode 0700 itself). The pod publishes
# 127.0.0.1:8484 (UI via Traefik / SSH tunnel) and 127.0.0.1:8485 (break-glass listener only,
# never WAN-routed).

FROM node:24 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:web

# helm — the tenant validation engine shells `helm template` over a cloned
# catalog workdir (server/adapters/helm/helm.ts). The release binary is statically linked (Go,
# CGO_ENABLED=0), so it is fetched on alpine and runs unchanged on the Debian-slim runtime.
FROM alpine:3.20 AS helm
ARG HELM_VERSION=v3.16.4
# apk's mirror-index fetch AND the helm download both hit external CDNs, so a transient blip (an apk
# "temporary error (try again later)", a slow release tag) must never fail the whole image build. Retry
# each up to 5x with a short backoff and fail loudly only if EVERY attempt fails. The helm download uses
# -o + a separate extract (not a pipe) so a partial fetch cannot feed tar a truncated stream on a retry.
RUN set -eux; \
    for i in 1 2 3 4 5; do if apk add --no-cache curl tar; then break; fi; if [ "$i" -eq 5 ]; then echo "apk add failed after 5 tries"; exit 1; fi; echo "apk add retry $i/5"; sleep 3; done; \
    case "$(uname -m)" in x86_64) h=amd64;; aarch64) h=arm64;; *) echo "unsupported arch $(uname -m)"; exit 1;; esac; \
    for i in 1 2 3 4 5; do if curl -fsSL "https://get.helm.sh/helm-${HELM_VERSION}-linux-${h}.tar.gz" -o /tmp/helm.tgz; then break; fi; if [ "$i" -eq 5 ]; then echo "helm download failed after 5 tries"; exit 1; fi; echo "helm download retry $i/5"; sleep 3; done; \
    tar -xzf /tmp/helm.tgz -C /tmp; \
    install -m0755 "/tmp/linux-${h}/helm" /usr/local/bin/helm; \
    rm -f /tmp/helm.tgz; \
    /usr/local/bin/helm version --short

FROM node:24-slim AS runtime
ENV NODE_ENV=production
# git — the Manager shells `git` for BOTH the validation clone (GitRepoReader,
# adapters/git) and the GitOps pointer commit (GitPlatformRepo); node:24-slim ships
# without it. ca-certificates for the HTTPS git remotes. Installed as root here, before
# dropping to USER node below.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# node:24-slim ships a non-root `node` user (uid 1000).
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/tsconfig.json ./tsconfig.json
# The tenant validator's helm binary (on PATH; config.ts drives it via `helm template`).
COPY --from=helm /usr/local/bin/helm /usr/local/bin/helm
USER node
EXPOSE 8484 8485
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8484/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "server/index.ts"]
