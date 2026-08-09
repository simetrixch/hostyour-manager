# dbtools — the client-tools image of the move / backup / restore
# job: one mechanism, three purposes (dump into the staging area, restore from
# it; keep the folder and it is a backup).
#
# The toolset is exactly what the job scripts run and nothing that serves
# anything:
#   mongodb-database-tools  mongodump / mongorestore
#   mongodb-mongosh         mongosh — lists the unit's databases before a dump
#                           (listDatabases) and drops them at clear-source
#                           (dropDatabase); the dump tools can do neither
#   postgresql-client       pg_dumpall / psql
#   rclone                  the object-store client (S3-compatible copy in/out)
#   openssh-client          ssh / sftp to the Hetzner Storage Box staging area
#
# VERSION COUPLING: the database clients are installed per
# platform/versions.yaml — the MongoDB apt-repo series comes from
# .images.mongodb and the PostgreSQL client major from .images.postgres, read
# with yq below. No client version literal lives in this file, so raising a
# database version and rebuilding the dump tools are ONE change: the release
# pipeline builds this image from the same tagged tree that carries the raise.
#
# Debian, not Alpine: MongoDB ships mongosh and the database tools as glibc
# builds only (deb/rpm — no musl build exists), so the official per-series apt
# repo is the one install path that both provides mongosh and stays coupled to
# .images.mongodb. The PostgreSQL client comes from the PGDG apt repo for the
# same reason: Debian's own archive carries a single frozen major.

FROM docker.io/library/debian:12-slim

# Stamped by hostyour-cloud/tools/ops/sync-versions out of platform/versions.yaml:
# MONGO_SERIES is .images.mongodb cut to <major>.<minor>, PG_MAJOR is
# .images.postgres cut to <major>. Edit them there, never here.
ARG MONGO_SERIES=8.0
ARG PG_MAJOR=18

# The apt suite is read from the base image itself (/etc/os-release), so the
# FROM tag above is the only place the Debian release is stated.
RUN set -eu \
 && . /etc/os-release \
 && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && curl -fsSL "https://www.mongodb.org/static/pgp/server-${MONGO_SERIES}.asc" \
      | gpg --dearmor -o /usr/share/keyrings/mongodb-server.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/mongodb-server.gpg] https://repo.mongodb.org/apt/debian ${VERSION_CODENAME}/mongodb-org/${MONGO_SERIES} main" \
      > /etc/apt/sources.list.d/mongodb-org.list \
 && curl -fsSL "https://www.postgresql.org/media/keys/ACCC4CF8.asc" \
      | gpg --dearmor -o /usr/share/keyrings/postgresql.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/postgresql.gpg] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      mongodb-database-tools \
      mongodb-mongosh \
      "postgresql-client-${PG_MAJOR}" \
      rclone \
      openssh-client \
 && apt-get purge -y --auto-remove curl gnupg \
 && rm -rf /var/lib/apt/lists/*

# No entrypoint: the job manifest supplies the command — the image only
# carries the tools.
CMD ["bash"]
