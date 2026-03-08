FROM node:22-bookworm

WORKDIR /app

# Install wget for downloading the Data Extraction Module
RUN apt-get update && apt-get install -y wget && rm -rf /var/lib/apt/lists/*

# Download and install Apryse Data Extraction Module
RUN mkdir -p /app/apryse-modules && \
    cd /app/apryse-modules && \
    wget -q https://www.pdftron.com/downloads/DataExtractionModuleLinux.tar.gz -O de.tar.gz && \
    tar -xzf de.tar.gz && \
    rm de.tar.gz && \
    ls -la /app/apryse-modules/

# Copy package files and install dependencies
COPY package.json ./
RUN npm install --omit=dev

# Copy server code
COPY server.js ./

ENV PORT=8080
ENV APRYSE_MODULE_PATH=/app/apryse-modules
ENV NODE_ENV=production

EXPOSE 8080

CMD ["node", "server.js"]
