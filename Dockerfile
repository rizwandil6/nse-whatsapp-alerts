# Only used by the "web" Railway service (root-directory service in this
# monorepo -- see Procfile's "web:" line). The other services in this repo
# (darvasbox-live, swing-strategy, rs-momentum-strategy-live) each have their
# own Railway "root directory" set to a subdirectory and build independently
# via Railway's default Railpack auto-detection -- this Dockerfile does not
# apply to them and does not change how they build.
#
# Added 2026-08-11 specifically to get the `tesseract-ocr` NATIVE binary onto
# the box for PdfExtractor's OCR fallback (tess4j is a JNA wrapper -- the
# Maven dependency alone does nothing without this system package). Without
# this Dockerfile, Railway's plain Railpack/Maven auto-build has no way to
# install an OS package. If OCR support is ever removed, this Dockerfile can
# be deleted and the service reverts to Railway's default Railpack build.
#
# IMPORTANT (verify before merging): replicates ONLY the Procfile's "web:"
# line (the Java jar). The Procfile's "swing:" line is NOT included here --
# per Railway's service list at the time this was written, "swing-strategy"
# is already its own separate Railway service with its own root directory
# (swing-strategy/live), so that Procfile line appears to be legacy/unused
# by the "web" service specifically. Confirm this is still true before
# merging -- if "web" is somehow also expected to run the swing process,
# this Dockerfile needs a process manager (e.g. a small entrypoint script)
# to run both.

FROM maven:3.9-eclipse-temurin-17 AS build
WORKDIR /build
COPY pom.xml .
RUN mvn -B -q dependency:go-offline
COPY src ./src
RUN mvn -B -q -DskipTests package

FROM eclipse-temurin:17-jre-jammy
RUN apt-get update \
    && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng \
    && rm -rf /var/lib/apt/lists/*
# Ubuntu Jammy's tesseract-ocr (4.1.1) installs trained-data here. If a base
# image change ever bumps the packaged Tesseract version, this path may need
# updating -- PdfExtractor's OCR fallback degrades safely (logs a warning,
# skips OCR) rather than crashing if this is ever wrong, so a mismatch here
# is a silent feature regression, not an outage. Verify with:
#   docker run --rm <image> find / -name 'eng.traineddata'
ENV TESSDATA_PREFIX=/usr/share/tesseract-ocr/4.00/tessdata

WORKDIR /app
COPY --from=build /build/target/nse-whatsapp-alerts-0.0.1-SNAPSHOT.jar app.jar

CMD ["java", "-Duser.timezone=Asia/Kolkata", "-Xmx256m", "-jar", "app.jar"]
