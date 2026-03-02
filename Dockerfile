FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./ 

RUN apk add --no-cache ffmpeg build-base python3 libsodium-dev opus-dev
RUN npm install --production

COPY . .

ENV NODE_ENV=production

CMD ["npm", "start"]

