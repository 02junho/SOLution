# 배포용 화면 이미지: 빌드한 화면(dist)을 nginx가 내주고, /api는 Spring으로 넘긴다 (nginx.conf).
# 개발할 때는 이 이미지를 쓰지 않고 npm run dev(5173)로 띄운다.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
