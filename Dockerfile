# Set base image
ARG BUILD_FROM
FROM $BUILD_FROM

# Set the working directory
#WORKDIR /usr/src/app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy other files separately to enable caching
COPY . .

# Expose port
EXPOSE 1234

# Run the app and scripts
CMD node ./scripts/easee-query.js & node ./scripts/mwtt-control.js & npm run dev