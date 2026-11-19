FROM node:22-bookworm-slim
ENV TZ=Asia/Shanghai PLAYWRIGHT_BROWSERS_PATH=/opt/browsers
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip python3-venv adb && rm -rf /var/lib/apt/lists/*
WORKDIR /opt
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npx playwright install --with-deps chromium && npm cache clean --force
# DSH is optional. Set an explicit package version if CLI mode is needed.
ARG DSH_PACKAGE=
RUN if [ -n "$DSH_PACKAGE" ]; then npm install -g "$DSH_PACKAGE" && command -v dsh; fi
COPY build/requirements-tools.txt /opt/requirements-tools.txt
RUN python3 -m venv /opt/python && /opt/python/bin/pip install --no-cache-dir -r /opt/requirements-tools.txt
ENV PATH="/opt/python/bin:${PATH}" BILI_PYTHON=/opt/python/bin/python
COPY bridge /opt/hand
COPY workspace-seed /opt/workspace-seed
COPY LICENSE THIRD_PARTY_NOTICES.md /opt/
COPY build/entrypoint.mjs build/seed-workspace.mjs /opt/
RUN install -d -m 0700 -o node -g node /workspace /var/lib/whalenest
ENV DSH_HOME=/var/lib/whalenest
USER node
WORKDIR /workspace
ENTRYPOINT ["node","/opt/entrypoint.mjs"]
