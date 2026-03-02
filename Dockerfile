FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./ 

RUN apk add --no-cache ffmpeg
RUN npm install --production

COPY . .

ENV NODE_ENV=production

CMD ["npm", "start"]

