FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install --yes --no-install-recommends bash ca-certificates fd-find git jq ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd

RUN useradd --create-home --uid 10001 sandbox

USER sandbox
WORKDIR /workspace

ENTRYPOINT []
