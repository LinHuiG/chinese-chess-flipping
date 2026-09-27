FROM maven:3.9.11-eclipse-temurin-21 AS build
WORKDIR /workspace
COPY pom.xml .
COPY src ./src
RUN mvn --batch-mode --no-transfer-progress verify

FROM eclipse-temurin:21-jre-jammy
WORKDIR /app
RUN groupadd --gid 10001 app && useradd --uid 10001 --gid app --no-create-home app
COPY --from=build --chown=10001:10001 /workspace/target/chess-server.jar /app/server.jar
USER 10001:10001
ENV TCP_PORT=9000 TCP_WORKER_THREADS=4
EXPOSE 9000/tcp
ENTRYPOINT ["java", "-jar", "/app/server.jar"]
