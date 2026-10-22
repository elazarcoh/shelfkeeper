# Headless Calibre content server for development. Imports dev-data/ebooks (read-only mount) on first start.
FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends calibre xvfb xauth ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 8080
ENTRYPOINT ["/entrypoint.sh"]
