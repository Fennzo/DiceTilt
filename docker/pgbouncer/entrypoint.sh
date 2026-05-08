#!/bin/sh
set -eu

: "${POSTGRES_HOST:=postgres}"
: "${POSTGRES_PORT:=5432}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"

: "${PGBOUNCER_PORT:=6432}"
: "${PGBOUNCER_POOL_MODE:=transaction}"
: "${PGBOUNCER_MAX_CLIENT_CONN:=300}"
: "${PGBOUNCER_DEFAULT_POOL_SIZE:=25}"
: "${PGBOUNCER_MIN_POOL_SIZE:=5}"
: "${PGBOUNCER_RESERVE_POOL_SIZE:=5}"
: "${PGBOUNCER_CLIENT_IDLE_TIMEOUT:=45}"

mkdir -p /etc/pgbouncer

cat > /etc/pgbouncer/userlist.txt <<EOF
"${POSTGRES_USER}" "${POSTGRES_PASSWORD}"
EOF

cat > /etc/pgbouncer/pgbouncer.ini <<EOF
[databases]
${POSTGRES_DB} = host=${POSTGRES_HOST} port=${POSTGRES_PORT} dbname=${POSTGRES_DB}

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = ${PGBOUNCER_PORT}
auth_type = plain
auth_file = /etc/pgbouncer/userlist.txt
pool_mode = ${PGBOUNCER_POOL_MODE}
max_client_conn = ${PGBOUNCER_MAX_CLIENT_CONN}
default_pool_size = ${PGBOUNCER_DEFAULT_POOL_SIZE}
min_pool_size = ${PGBOUNCER_MIN_POOL_SIZE}
reserve_pool_size = ${PGBOUNCER_RESERVE_POOL_SIZE}
reserve_pool_timeout = 5
server_reset_query = DISCARD ALL
server_check_delay = 30
client_idle_timeout = ${PGBOUNCER_CLIENT_IDLE_TIMEOUT}
ignore_startup_parameters = extra_float_digits
admin_users = ${POSTGRES_USER}
stats_users = ${POSTGRES_USER}
log_connections = 1
log_disconnections = 1
pidfile = /var/run/pgbouncer/pgbouncer.pid
EOF

# Remove stale pidfile from previous unclean shutdown (Docker kill without SIGTERM)
rm -f /var/run/pgbouncer/pgbouncer.pid

chown -R pgbouncer:pgbouncer /etc/pgbouncer /var/run/pgbouncer
exec su-exec pgbouncer pgbouncer /etc/pgbouncer/pgbouncer.ini
