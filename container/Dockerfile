# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation

FROM node:22-slim

# Switch to a China mirror for faster package downloads, then install deps.
RUN set -eux; \
    sources_file=/etc/apt/sources.list.d/debian.sources; \
    if [ ! -f "$sources_file" ]; then sources_file=/etc/apt/sources.list; fi; \
    sed -i 's|https://mirrors.tuna.tsinghua.edu.cn/debian-security|http://mirrors.tuna.tsinghua.edu.cn/debian-security|g; s|https://mirrors.tuna.tsinghua.edu.cn/debian|http://mirrors.tuna.tsinghua.edu.cn/debian|g; s|http://deb.debian.org/debian-security|http://mirrors.tuna.tsinghua.edu.cn/debian-security|g; s|http://deb.debian.org/debian|http://mirrors.tuna.tsinghua.edu.cn/debian|g' "$sources_file"; \
    if ! apt-get update \
      -o Acquire::Retries=5 \
      -o Acquire::http::Timeout=30 \
      -o Acquire::https::Timeout=30; then \
      echo "Mirror update failed, falling back to deb.debian.org"; \
      sed -i 's|http://mirrors.tuna.tsinghua.edu.cn/debian-security|http://deb.debian.org/debian-security|g; s|http://mirrors.tuna.tsinghua.edu.cn/debian|http://deb.debian.org/debian|g' "$sources_file"; \
      apt-get update \
        -o Acquire::Retries=5 \
        -o Acquire::http::Timeout=30 \
        -o Acquire::https::Timeout=30; \
    fi; \
    apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    python3-pip \
    python3-venv \
    poppler-utils \
    qpdf \
    && rm -rf /var/lib/apt/lists/*

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install agent-browser and claude-code globally
RUN npm install -g agent-browser @anthropic-ai/claude-code

# Python deps for PDF skill (PEP 668-safe via virtualenv)
RUN set -eux; \
    python3 -m venv /opt/pydeps; \
    PIP_OPTS="--no-cache-dir --retries 5 --timeout 60"; \
    MIRROR_OPTS="-i http://pypi.tuna.tsinghua.edu.cn/simple --trusted-host pypi.tuna.tsinghua.edu.cn"; \
    if ! /opt/pydeps/bin/pip install $PIP_OPTS $MIRROR_OPTS --upgrade pip setuptools wheel; then \
      echo "PyPI mirror failed, falling back to default index"; \
      /opt/pydeps/bin/pip install $PIP_OPTS --upgrade pip setuptools wheel; \
    fi; \
    if ! /opt/pydeps/bin/pip install $PIP_OPTS $MIRROR_OPTS reportlab pypdf pdfplumber pandas openpyxl; then \
      echo "PyPI mirror failed for deps, falling back to default index"; \
      /opt/pydeps/bin/pip install $PIP_OPTS reportlab pypdf pdfplumber pandas openpyxl; \
    fi
ENV PATH="/opt/pydeps/bin:${PATH}"

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY agent-runner/ ./

# Build TypeScript
RUN npm run build

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Create entrypoint script
# Secrets are passed via stdin JSON — temp file is deleted immediately after Node reads it
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
RUN printf '#!/bin/bash\nset -e\ncd /app && npx tsc --outDir /tmp/dist 2>&1 >&2\nln -s /app/node_modules /tmp/dist/node_modules\nchmod -R a-w /tmp/dist\ncat > /tmp/input.json\nnode /tmp/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace && chmod 777 /home/node

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
