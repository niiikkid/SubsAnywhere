# syntax=docker/dockerfile:1
FROM ghcr.io/astral-sh/uv:0.11.8 AS uv
FROM python:3.11-slim-bookworm AS runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    PATH="/app/.venv/bin:$PATH" \
    SUBSANYWHERE_HOST=0.0.0.0 \
    SUBSANYWHERE_PORT=43817 \
    SUBSANYWHERE_OUTPUT_DIR=/data/subtitles \
    HOME=/tmp

RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 subsanywhere \
    && useradd --uid 10001 --gid 10001 --no-create-home subsanywhere \
    && mkdir -p /app /data/subtitles \
    && chown -R 10001:10001 /data
COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /app
COPY local-server/pyproject.toml local-server/uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv uv sync --frozen --no-dev --no-editable
COPY local-server/*.py ./
USER 10001:10001
EXPOSE 43817
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["python", "healthcheck.py"]
CMD ["python", "server.py"]
