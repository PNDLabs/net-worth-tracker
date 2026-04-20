#!/bin/sh
set -e

: "${BASIC_AUTH_USER:?BASIC_AUTH_USER environment variable is required}"
: "${BASIC_AUTH_PASS:?BASIC_AUTH_PASS environment variable is required}"

# Generate the htpasswd file from env vars at container start so credentials
# are never baked into the image.
htpasswd -bc /etc/nginx/.htpasswd "$BASIC_AUTH_USER" "$BASIC_AUTH_PASS"

exec nginx -g "daemon off;"
