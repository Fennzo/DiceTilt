FROM alpine:3.20

RUN apk add --no-cache pgbouncer postgresql-client su-exec \
  && addgroup -S pgbouncer \
  && adduser -S -D -H -G pgbouncer pgbouncer \
  && mkdir -p /etc/pgbouncer /var/run/pgbouncer \
  && chown -R pgbouncer:pgbouncer /etc/pgbouncer /var/run/pgbouncer

COPY docker/pgbouncer/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
