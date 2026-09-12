# Build explicitly; the resulting immutable image ID is the runner setting.
FROM node:26.5.0-bookworm-slim@sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb AS controller
RUN cp -L /usr/lib/*-linux-gnu/libatomic.so.1 /tmp/libatomic.so.1
FROM python:3.13.12-slim-bookworm@sha256:a58daefb915e1e03ad48f3ca4df8832065412c5c35cacb9d39f4229184de12b6
COPY --from=controller /usr/local/bin/node /usr/local/bin/node
COPY --from=controller /tmp/libatomic.so.1 /usr/lib/libatomic.so.1
RUN node --version && python --version && python -m pip --version
# No packages, credentials, project source or model dependencies in this image.
