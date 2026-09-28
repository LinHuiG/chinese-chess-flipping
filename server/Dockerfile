FROM rust:1-alpine AS build
RUN apk add --no-cache musl-dev
WORKDIR /workspace
COPY Cargo.toml Cargo.lock ./
COPY src/*.rs ./src/
COPY src/main/resources/web ./src/main/resources/web
RUN cargo build --locked --release

FROM scratch
WORKDIR /app
COPY --from=build --chown=10001:10001 /workspace/target/release/chess-server /app/chess-server
USER 10001:10001
ENV TCP_PORT=8888 HTTP_PORT=80 UDP_PORT=8888 TCP_WORKER_THREADS=4
EXPOSE 8888/tcp 80/tcp 8888/udp
ENTRYPOINT ["/app/chess-server"]
