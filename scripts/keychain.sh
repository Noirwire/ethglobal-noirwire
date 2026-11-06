#!/usr/bin/env bash
# Testnet signing keys in the macOS login Keychain. Keys are never printed and never written to disk.
# Entry: generic password, service $KEYCHAIN_SERVICE, account <role>.
# EVM roles hold a 0x private key; Solana roles hold the JSON byte array string.
set -euo pipefail

SVC="${KEYCHAIN_SERVICE:-noirwire-ethglobal}"
KEYS_DIR="${KEYS_DIR:-.keys}"
EVM_ROLES="deployer operator relayer hl-agent taker"
SOL_ROLES="solana-operator solana-depositor"
ALL_ROLES="$EVM_ROLES $SOL_ROLES"

die() { echo "keychain: $*" >&2; exit 1; }
is_sol() { [[ $1 == solana-* ]]; }
valid_role() { [[ " $ALL_ROLES " == *" $1 "* ]]; }
has() { security find-generic-password -s "$SVC" -a "$1" >/dev/null 2>&1; }
read_key() { security find-generic-password -s "$SVC" -a "$1" -w; }
store() { security add-generic-password -U -s "$SVC" -a "$1" -w "$2" >/dev/null; }

roles_or_all() {
  if [[ $# -eq 0 ]]; then echo "$ALL_ROLES"; return; fi
  for r in "$@"; do valid_role "$r" || die "unknown role: $r (roles: $ALL_ROLES)"; done
  echo "$@"
}

address_of() {
  if is_sol "$1"; then
    solana-keygen pubkey <(read_key "$1")
  else
    cast wallet address --private-key "$(read_key "$1")"
  fi
}

generate() {
  if is_sol "$1"; then
    solana-keygen new --no-bip39-passphrase --silent --force -o /dev/stdout | sed -n 's/^\(\[[0-9,]*\]\).*/\1/p'
  else
    cast wallet new --json | jq -r '.data[0].private_key'
  fi
}

cmd_init() {
  local role secret
  for role in $(roles_or_all "$@"); do
    if has "$role" && [[ "${FORCE:-}" != 1 ]]; then
      echo "$role  exists, kept (FORCE=1 replaces it)"
      continue
    fi
    secret="$(generate "$role")"
    [[ -n "$secret" ]] || die "could not generate a key for $role"
    store "$role" "$secret"
    secret=""
    echo "$role  $(address_of "$role")"
  done
}

cmd_addresses() {
  local role
  for role in $(roles_or_all "$@"); do
    if has "$role"; then echo "$role  $(address_of "$role")"; else echo "$role  not set"; fi
  done
}

cmd_migrate() {
  local role file secret migrated=""
  for role in $ALL_ROLES; do
    if is_sol "$role"; then file="$KEYS_DIR/$role.keypair.json"; else file="$KEYS_DIR/evm-$role.json"; fi
    if [[ ! -f "$file" ]]; then echo "$role  no legacy file, skipped"; continue; fi
    if has "$role" && [[ "${FORCE:-}" != 1 ]]; then echo "$role  exists, kept (FORCE=1 replaces it)"; continue; fi
    if is_sol "$role"; then
      secret="$(jq -c . "$file" 2>/dev/null)" || secret=""
    else
      secret="$(jq -r '.data[0].private_key' "$file" 2>/dev/null)" || secret=""
    fi
    if [[ -z "$secret" || "$secret" == null ]]; then echo "$role  unreadable legacy file, skipped"; continue; fi
    store "$role" "$secret"
    secret=""
    migrated="$migrated $role"
  done
  for role in $migrated; do echo "$role  $(address_of "$role")"; done
}

# run (-e VAR=role | -f VAR=role)... -- command args
# -e puts the key in the child's environment. -f puts a /dev/fd/N path in it (single read), no file is written.
cmd_run() {
  local fd=3 spec var role
  local exports=()
  while [[ $# -gt 0 && "$1" != -- ]]; do
    [[ $# -ge 2 ]] || die "run: $1 needs VAR=role"
    spec="$2"; var="${spec%%=*}"; role="${spec#*=}"
    valid_role "$role" || die "unknown role: $role"
    has "$role" || die "no keychain entry for $role in service $SVC (human runs: make keys-init)"
    case "$1" in
      -e) exports+=("$var=$(read_key "$role")") ;;
      -f)
        [[ $fd -le 8 ]] || die "run: too many -f keys"
        eval "exec $fd< <(read_key \"\$role\")"
        exports+=("$var=/dev/fd/$fd")
        fd=$((fd + 1))
        ;;
      *) die "run: unknown flag $1" ;;
    esac
    shift 2
  done
  [[ "${1:-}" == -- ]] || die "run: expected -- before the command"
  shift
  [[ $# -gt 0 ]] || die "run: no command"
  if [[ ${#exports[@]} -gt 0 ]]; then
    for spec in "${exports[@]}"; do export "$spec"; done
  fi
  exec "$@"
}

main() {
  local sub="${1:-}"
  [[ $# -gt 0 ]] && shift
  case "$sub" in
    init) cmd_init "$@" ;;
    addresses) cmd_addresses "$@" ;;
    migrate) cmd_migrate "$@" ;;
    run) cmd_run "$@" ;;
    *) die "usage: keychain.sh init|addresses|migrate [role...] | run (-e|-f VAR=role)... -- command" ;;
  esac
}

main "$@"
