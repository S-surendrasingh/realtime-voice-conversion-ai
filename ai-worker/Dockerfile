# CPU-only image for the AI worker. NOT wired into docker-compose.yml yet —
# see ../docs/phase3-ai-conversion.md "Known Limitations" for why (this
# sandbox had no Docker daemon access to build/verify a cross-container
# integration, so it isn't shipped unverified). Provided so that follow-up
# work has a real starting point rather than nothing.
#
# No CUDA base image, no GPU packages — torch is installed from the CPU
# wheel index explicitly, never the default (CUDA) index.
FROM python:3.10-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends git build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml ./
COPY app ./app

RUN pip install --no-cache-dir torch torchaudio torchvision --index-url https://download.pytorch.org/whl/cpu \
    && pip install --no-cache-dir .

# Vendored upstream source (GPL-3.0 — see ../docs/model-selection.md),
# cloned at build time rather than committed to this project's own history.
RUN git clone --depth 1 https://github.com/Plachtaa/seed-vc.git vendor/seed-vc

# Model weights are intentionally NOT baked into the image — they download
# into this volume on first load. Mount a persistent volume here in any
# real deployment so every container restart doesn't re-download ~1.5-2GB.
VOLUME ["/root/.voiceshift/models"]

ENTRYPOINT ["python", "-m", "app.main"]
CMD ["health-check"]
