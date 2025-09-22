# Set base image
ARG BUILD_FROM
FROM $BUILD_FROM

# Set environment variables
ENV LANG C.UTF-8

# Install Node.js and npm
RUN apk add --no-cache nodejs npm

# Create and set working directory
WORKDIR /st-mq

# Create symbolic links
RUN ln -s /share /st-mq/share && \
    ln -s /data /st-mq/data

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy other files separately to enable caching
COPY chart/ ./chart/
COPY scripts/ ./scripts/
COPY scheduler.js ./
COPY vite.config.js ./

# Run scheduler.js
CMD [ "node", "scheduler.js" ]
