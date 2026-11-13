#!/usr/bin/env bash
# Oracle 서버(Ubuntu)에서 root로 실행: sudo bash remote-deploy.sh <release.tar.gz>
# - /opt/las-vegas/releases/<시각> 에 새 버전을 풀고 current 링크를 바꿉니다.
# - systemd 서비스 las-vegas (127.0.0.1:3102) 를 재시작합니다.
# - After Hours 의 Caddy(HTTPS)에 lasvegas 도메인을 한 번만 추가합니다.
set -euo pipefail

TARBALL="${1:?usage: remote-deploy.sh <release.tar.gz>}"
BASE=/opt/las-vegas
PORT=3102
DOMAIN=lasvegas.137-131-50-244.sslip.io
CADDY_BIN=/opt/after-hours/runtime/caddy
CADDYFILE=/opt/after-hours/Caddyfile
NODE_VERSION=v24.20.0
NODE_SHA256=2f2c0da162318f0de47665410c7c8c2ed3d36c8f3105de4bbc61176c70a7cbf2
STAMP="$(date +%Y%m%d-%H%M%S)"
REL="$BASE/releases/$STAMP"

install -d "$BASE/runtime" "$REL"

# 1) Node.js 런타임 (처음 한 번만, 체크섬 확인)
if [ ! -x "$BASE/runtime/bin/node" ]; then
  curl -fL --retry 3 "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.xz" -o /tmp/las-vegas-node.tar.xz
  echo "$NODE_SHA256  /tmp/las-vegas-node.tar.xz" | sha256sum -c -
  tar -xJf /tmp/las-vegas-node.tar.xz -C "$BASE/runtime" --strip-components=1
  rm -f /tmp/las-vegas-node.tar.xz
fi
export PATH="$BASE/runtime/bin:$PATH"

# 2) 실행 전용 시스템 사용자
if ! id las-vegas >/dev/null 2>&1; then
  useradd --system --home /nonexistent --no-create-home --shell /usr/sbin/nologin las-vegas
fi

# 3) 새 릴리스 풀기 + 의존성 설치
tar -xzf "$TARBALL" -C "$REL" --no-same-owner
cd "$REL"
npm ci --omit=dev --no-audit --no-fund
chown -R root:root "$REL"
chmod -R a+rX "$REL"
ln -sfn "$REL" "$BASE/current"

# 4) systemd 서비스
cat > /etc/systemd/system/las-vegas.service <<UNIT
[Unit]
Description=Las Vegas board game (multiplayer)
After=network.target
[Service]
User=las-vegas
Group=las-vegas
WorkingDirectory=$BASE/current
Environment=NODE_ENV=production
Environment=HOST=127.0.0.1
Environment=PORT=$PORT
ExecStart=$BASE/runtime/bin/node --max-old-space-size=96 server.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
MemoryMax=160M
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable las-vegas.service >/dev/null
systemctl restart las-vegas.service
curl -fsS --retry 10 --retry-connrefused --retry-delay 1 "http://127.0.0.1:$PORT/health"
echo

# 5) Caddy(HTTPS)에 도메인 추가 (이미 있으면 건너뜀)
if ! grep -q "^$DOMAIN " "$CADDYFILE"; then
  cp "$CADDYFILE" "$CADDYFILE.bak-$STAMP"
  cat >> "$CADDYFILE" <<CADDY
$DOMAIN {
 tls {
  issuer acme {
   disable_http_challenge
  }
 }
 reverse_proxy 127.0.0.1:$PORT
}
CADDY
  if ! "$CADDY_BIN" validate --config "$CADDYFILE" --adapter caddyfile; then
    cp "$CADDYFILE.bak-$STAMP" "$CADDYFILE"
    echo "Caddyfile 검증 실패 - 원래대로 되돌렸습니다." >&2
    exit 1
  fi
  systemctl restart after-hours-web.service
fi

# 6) 오래된 릴리스 정리 (최근 3개 유지)
ls -1dt "$BASE"/releases/* | tail -n +4 | xargs -r rm -rf

systemctl is-active las-vegas.service after-hours.service after-hours-web.service
echo "배포 완료: https://$DOMAIN"
