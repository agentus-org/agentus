#!/usr/bin/env bash
# Generate the self-signed certificate for AgentSlot's TLS listener — the one a public
# tunnel points at. Rationale (see README § "Exposing it publicly"):
#   * no CA will issue for an unregistered domain / bare IP, so self-signed + TOFU is
#     the only option for this operator;
#   * the CN/SAN is the DDNS NAME that is actually typed in the address bar. A dynamic
#     public IP (telecom PPPoE) must never be baked in: it changes and the cert would
#     have to be re-issued, and a mismatched name is a second warning on top of the
#     "untrusted issuer" one.
# localhost/127.0.0.1 ride along so a local `curl https://127.0.0.1:8443` does not also
# complain about the name (it still complains about the issuer — that is expected).
#
#   scripts/make-cert.sh [name]        # default: i207f47592.wicp.vip
set -euo pipefail

NAME="${1:-${AGENTSLOT_TLS_NAME:-i207f47592.wicp.vip}}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${AGENTSLOT_TLS_DIR:-$ROOT/packages/server/.data/tls}"
mkdir -p "$OUT"

cat > "$OUT/tls.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions    = v3
prompt             = no

[dn]
CN = $NAME

[v3]
subjectAltName   = DNS:$NAME, DNS:localhost, IP:127.0.0.1
basicConstraints = critical, CA:TRUE
keyUsage         = critical, digitalSignature, keyEncipherment, keyCertSign
extendedKeyUsage = serverAuth
EOF

openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout "$OUT/key.pem" -out "$OUT/cert.pem" -config "$OUT/tls.cnf" 2>/dev/null

chmod 600 "$OUT/key.pem" "$OUT/cert.pem"
chmod 644 "$OUT/tls.cnf"

echo "cert -> $OUT/cert.pem"
# LibreSSL has no `x509 -ext`; read the SAN out of -text instead.
openssl x509 -in "$OUT/cert.pem" -noout -subject -dates
openssl x509 -in "$OUT/cert.pem" -noout -text | grep -A1 "Subject Alternative Name" || true
openssl x509 -in "$OUT/cert.pem" -noout -fingerprint -sha256
echo
echo "restart the server (or let tsx watch reload) — it will log:"
echo "  [agentslot-server] https://0.0.0.0:8443 (self-signed cert — point a tunnel here, keep 8787 for the LAN)"
