#!/bin/sh
# Starts the hedger. The agent key the service reads from its environment is read
# here from the file HL_AGENT_PRIVATE_KEY_FILE names, so it is not in the image
# or in the container's configuration. A file that is named but missing or empty
# stops the start, and nothing is echoed.
set -eu

fail() {
  echo "$1 Nothing was started." >&2
  exit 78
}

if [ -n "${HL_AGENT_PRIVATE_KEY_FILE:-}" ]; then
  [ -s "$HL_AGENT_PRIVATE_KEY_FILE" ] || fail "HL_AGENT_PRIVATE_KEY_FILE names $HL_AGENT_PRIVATE_KEY_FILE, which is missing or empty."
  key=$(tr -d ' \t\r\n' <"$HL_AGENT_PRIVATE_KEY_FILE") || fail "$HL_AGENT_PRIVATE_KEY_FILE cannot be read by user $(id -u)."
  [ -n "$key" ] || fail "$HL_AGENT_PRIVATE_KEY_FILE holds no key."
  export HL_AGENT_PRIVATE_KEY="$key"
fi

exec node_modules/.bin/tsx src/main.ts
