#!/bin/sh
# Starts the bridge. The two EVM keys the service reads from its environment are
# read here from the files ARC_OPERATOR_KEY_FILE and HYPERCORE_ACCOUNT_KEY_FILE
# name, so no key is in the image or in the container's configuration. A file
# that is named but missing or empty stops the start, and nothing is echoed.
set -eu

fail() {
  echo "$1 Nothing was started." >&2
  exit 78
}

key_from_file() {
  name="$1"
  eval "file=\${${name}_FILE:-}"
  [ -n "$file" ] || return 0
  [ -s "$file" ] || fail "${name}_FILE names $file, which is missing or empty."
  value=$(tr -d ' \t\r\n' <"$file") || fail "$file cannot be read by user $(id -u)."
  [ -n "$value" ] || fail "$file holds no key."
  export "$name=$value"
}

key_from_file ARC_OPERATOR_KEY
key_from_file HYPERCORE_ACCOUNT_KEY

exec node_modules/.bin/tsx src/main.ts
