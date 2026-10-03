#!/usr/bin/env bash
# Issue the certificate AgentSlot's TLS listener uses — the public hop of a plain TCP tunnel.
#
# Structure: a self-signed ROOT (10 years) + a short-lived LEAF signed by it.
#   ca.pem           → what a phone/laptop installs ONCE (public; served at /cert.crt)
#   cert.pem/key.pem → what the listener presents; rotate these freely, devices are untouched.
#
# Why the split: Apple caps *TLS server certificate* validity (398 days since iOS 15), and one
# 10-year self-signed cert is exactly the shape a device refuses AFTER the user has been through
# the whole install dance. A root CA is not a server cert (no cap); the leaf stays under the cap,
# so yanking it yearly never touches a device.
#
# The CN/SAN is the DDNS NAME that is actually typed. A dynamic public IP must NOT be baked in
# (it changes, and a mismatch is one more warning). localhost/127.0.0.1 ride along so a local
# curl does not also complain about the name.
#
#   scripts/make-cert.sh [name]        # default: i207f47592.wicp.vip
#   scripts/make-cert.sh --leaf-only   # rotate the leaf; the root and installed devices stay
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${AGENTSLOT_TLS_DIR:-$ROOT_DIR/packages/server/.data/tls}"
LEAF_ONLY=0
if [ "${1:-}" = "--leaf-only" ]; then LEAF_ONLY=1; shift; fi
NAME="${1:-${AGENTSLOT_TLS_NAME:-i207f47592.wicp.vip}}"
LEAF_DAYS="${AGENTSLOT_TLS_DAYS:-390}"         # < 398 = Apple's cap for server certificates
ROOT_DAYS="${AGENTSLOT_TLS_ROOT_DAYS:-3650}"
mkdir -p "$OUT"

if [ "$LEAF_ONLY" = "0" ] || [ ! -f "$OUT/ca.pem" ] || [ ! -f "$OUT/ca.key" ]; then
  cat > "$OUT/ca.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions    = v3
prompt             = no

[dn]
CN = AgentSlot self-signed root ($NAME)

[v3]
basicConstraints = critical,CA:TRUE,pathlen:0
keyUsage         = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
EOF
  openssl req -x509 -newkey rsa:2048 -nodes -days "$ROOT_DAYS" \
    -keyout "$OUT/ca.key" -out "$OUT/ca.pem" -config "$OUT/ca.cnf" 2>/dev/null
  rm -f "$OUT/ca.srl"
  echo "root CA -> $OUT/ca.pem   (install THIS on devices; it is served at /cert.crt)"
fi

cat > "$OUT/leaf.cnf" <<EOF
[req]
distinguished_name = dn
prompt             = no

[dn]
CN = $NAME

[v3]
subjectAltName   = DNS:$NAME, DNS:localhost, IP:127.0.0.1
basicConstraints = critical,CA:FALSE
keyUsage         = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
EOF

openssl req -newkey rsa:2048 -nodes -keyout "$OUT/key.pem" -out "$OUT/leaf.csr" -config "$OUT/leaf.cnf" 2>/dev/null
openssl x509 -req -in "$OUT/leaf.csr" -CA "$OUT/ca.pem" -CAkey "$OUT/ca.key" -CAcreateserial \
  -days "$LEAF_DAYS" -out "$OUT/cert.pem" -extfile "$OUT/leaf.cnf" -extensions v3 2>/dev/null
rm -f "$OUT/leaf.csr"

chmod 600 "$OUT/key.pem" "$OUT/ca.key"
chmod 644 "$OUT/cert.pem" "$OUT/ca.pem" "$OUT/ca.cnf" "$OUT/leaf.cnf"

echo "leaf -> $OUT/cert.pem   (what the listener serves; rotates without touching devices)"
openssl x509 -in "$OUT/cert.pem" -noout -subject -issuer -dates
# LibreSSL has no `x509 -ext`; read the SAN out of -text instead.
openssl x509 -in "$OUT/cert.pem" -noout -text | grep -A1 "Subject Alternative Name" || true
openssl x509 -in "$OUT/ca.pem" -noout -subject -dates
echo
echo "restart the server (or let tsx watch reload); devices install the root once from"
echo "  https://$NAME:<tls-port>/cert.crt"
