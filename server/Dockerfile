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
ENV TCP_PORT=8888 HTTP_PORT=80 TCP_WORKER_THREADS=4
ENV JAVA_TOOL_OPTIONS="-Xms16m -Xmx128m -XX:+UseSerialGC -XX:MaxDirectMemorySize=16m -Xss512k"
EXPOSE 8888/tcp 80/tcp
ENTRYPOINT ["java", "-jar", "/app/server.jar"]
