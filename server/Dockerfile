FROM rust:1-alpine AS build
RUN apk add --no-cache musl-dev
WORKDIR /workspace
COPY Cargo.toml Cargo.lock ./
COPY src/*.rs ./src/
RUN cargo build --locked --release

FROM scratch
WORKDIR /app
COPY --from=build --chown=10001:10001 /workspace/target/release/chess-server /app/chess-server
# 网页和 APK 在编译阶段之后复制，资源变更可直接复用已缓存的 Rust 程序。
COPY --chown=10001:10001 src/main/resources/web /app/src/main/resources/web
COPY --chown=10001:10001 app-update /app/app-update
USER 10001:10001
ENV CHESS_RESOURCE_DIR=/app TCP_PORT=8888 HTTP_PORT=80 UDP_PORT=8888 TCP_WORKER_THREADS=4
EXPOSE 8888/tcp 80/tcp 8888/udp
ENTRYPOINT ["/app/chess-server"]
