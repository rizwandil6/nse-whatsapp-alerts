# Deterministic build for Railway (used instead of Nixpacks auto-detection, which
# was producing a "successful" build with no jar -> the web container looped
# "Unable to access jarfile"). Multi-stage: build the Spring Boot fat jar with
# Maven, then run it on a small JRE. The jar is placed at the same
# target/...jar path the app has always used, so nothing else needs to change.

# ---- build stage ----
FROM maven:3.9-eclipse-temurin-17 AS build
WORKDIR /app
COPY pom.xml .
COPY src ./src
RUN mvn -B -DskipTests clean package

# ---- runtime stage ----
FROM eclipse-temurin:17-jre
WORKDIR /app
COPY --from=build /app/target/nse-whatsapp-alerts-0.0.1-SNAPSHOT.jar target/nse-whatsapp-alerts-0.0.1-SNAPSHOT.jar
EXPOSE 8080
CMD ["java", "-Duser.timezone=Asia/Kolkata", "-Xmx256m", "-jar", "target/nse-whatsapp-alerts-0.0.1-SNAPSHOT.jar"]
