FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      curl \
      ffmpeg \
      fonts-dejavu-core \
      fonts-liberation \
      git \
      jq \
      libreoffice-core-nogui \
      libreoffice-writer-nogui \
      libreoffice-calc-nogui \
      libreoffice-impress-nogui \
      python3 \
      python3-pip \
      ripgrep \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 10001 sandbox \
    && useradd --uid 10001 --gid 10001 --create-home \
      --home-dir /home/sandbox --shell /bin/bash sandbox

USER 10001:10001
WORKDIR /workspace
CMD ["sleep", "infinity"]
