FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=8000 \
    HOST=0.0.0.0

RUN apt-get update && \
    apt-get install -y --no-install-recommends git ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /srv/cheesepie

COPY requirements.txt ./
RUN pip install -r requirements.txt

COPY . .
RUN chmod +x scripts/entrypoint.sh || true

EXPOSE 8000

ENTRYPOINT ["/srv/cheesepie/scripts/entrypoint.sh"]
