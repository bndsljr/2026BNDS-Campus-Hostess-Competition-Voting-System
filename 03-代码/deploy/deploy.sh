#!/usr/bin/env bash
# =============================================================================
# 2026 主持人大赛投票系统 —— 一键部署脚本
#
#   ./deploy/deploy.sh bootstrap   # 首次：装依赖、建用户/目录、写 nginx 与 systemd 配置
#   ./deploy/deploy.sh push        # 每次发布：上传代码、装依赖、重启服务
#   ./deploy/deploy.sh verify      # 验收：健康检查 + 双端口可达性
#   ./deploy/deploy.sh logs        # 查看应用日志
#   ./deploy/deploy.sh backup      # 立即备份一次数据
#
# 可用环境变量覆盖：
#   HOST=root@1.2.3.4  SSH_KEY=~/.ssh/id_ed25519_hostvote  REMOTE_DIR=/opt/hostvote
# =============================================================================
set -euo pipefail

HOST=${HOST:-root@YOUR_SERVER_IP}
SSH_KEY=${SSH_KEY:-$HOME/.ssh/id_ed25519_hostvote}
PUBLIC_IP=${PUBLIC_IP:-${HOST#*@}}
REMOTE_DIR=${REMOTE_DIR:-/opt/hostvote}
NODE_BIN=${NODE_BIN:-/usr/local/bin/node}
SERVICE=hostvote

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SSH_OPTS=(-i "$SSH_KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)
SSH() { ssh "${SSH_OPTS[@]}" "$HOST" "$@"; }
RSH() { ssh "${SSH_OPTS[@]}" "$HOST" bash -s; }

c_ok()   { printf '\033[32m✔\033[0m %s\n' "$*"; }
c_info() { printf '\033[36m·\033[0m %s\n' "$*"; }
c_warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
c_err()  { printf '\033[31m✘\033[0m %s\n' "$*" >&2; }

require_key() {
  if [ ! -f "$SSH_KEY" ]; then
    c_err "找不到 SSH 私钥：$SSH_KEY"
    exit 1
  fi
}

# ---------------------------------------------------------------- bootstrap ---
do_bootstrap() {
  require_key
  c_info "检查服务器环境 ..."
  RSH <<EOF
set -e
export DEBIAN_FRONTEND=noninteractive

# 1) Node.js（若未安装则安装官方 LTS 二进制包，无需编译）
if ! command -v node >/dev/null 2>&1; then
  echo "· 安装 Node.js LTS ..."
  mkdir -p /usr/local/src && cd /usr/local/src
  VER=\$(curl -fsSL https://nodejs.org/dist/index.json | python3 -c "import sys,json;d=json.load(sys.stdin);print([x['version'] for x in d if x.get('lts')][0])")
  curl -fsSLO "https://nodejs.org/dist/\$VER/node-\$VER-linux-x64.tar.xz"
  tar -xJf "node-\$VER-linux-x64.tar.xz" -C /usr/local
  ln -sfn "/usr/local/node-\$VER-linux-x64" /usr/local/node
  for b in node npm npx; do ln -sf /usr/local/node/bin/\$b /usr/local/bin/\$b; done
  npm config set registry https://registry.npmmirror.com >/dev/null
fi
echo "· Node: \$(node -v)  npm: \$(npm -v)"

# 2) Nginx
if ! command -v nginx >/dev/null 2>&1; then
  echo "· 安装 Nginx ..."
  apt-get update -qq && apt-get install -y -qq nginx
fi
echo "· Nginx: \$(nginx -v 2>&1)"

# 3) 系统用户与目录
id -u hostvote >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin hostvote
mkdir -p $REMOTE_DIR/{app,data,backup,logs}
mkdir -p $REMOTE_DIR/data/uploads
chown -R hostvote:hostvote $REMOTE_DIR
chmod 750 $REMOTE_DIR $REMOTE_DIR/data $REMOTE_DIR/backup $REMOTE_DIR/logs
# 让 nginx(www-data) 能读日志目录（如需）
usermod -aG hostvote www-data 2>/dev/null || true
echo "· 目录就绪：$REMOTE_DIR"

# 4) 关闭 Debian 默认站点，写入本项目站点配置
if [ -e /etc/nginx/sites-enabled/default ]; then
  rm -f /etc/nginx/sites-enabled/default
  echo "· 已移除 nginx 默认站点（避免占用 80 端口 default_server）"
fi
EOF

  c_info "上传 Nginx 与 systemd 配置 ..."
  scp "${SSH_OPTS[@]}" "$ROOT/deploy/nginx-hostvote.conf" "$HOST:/etc/nginx/conf.d/hostvote.conf"
  scp "${SSH_OPTS[@]}" "$ROOT/deploy/hostvote.service" "$HOST:/etc/systemd/system/$SERVICE.service"

  RSH <<EOF
set -e
nginx -t
systemctl daemon-reload
systemctl enable $SERVICE >/dev/null 2>&1 || true
systemctl restart nginx
echo "· nginx 已重启"
EOF
  c_ok "服务器基础环境就绪"
}

# --------------------------------------------------------------------- push ---
do_push() {
  require_key
  c_info "上传代码到 $HOST:$REMOTE_DIR/app ..."
  rsync -az --delete \
    -e "ssh ${SSH_OPTS[*]}" \
    --exclude 'node_modules' \
    --exclude 'data' \
    --exclude 'backup' \
    --exclude 'logs' \
    --exclude '.git' \
    --exclude '.DS_Store' \
    --exclude '*.log' \
    "$ROOT/" "$HOST:$REMOTE_DIR/app/"

  c_info "准备运行环境与 .env ..."
  RSH <<EOF
set -e
cd $REMOTE_DIR/app

if [ ! -f .env ]; then
  ADMIN_PASS=\$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | head -c 14)
  cat > .env <<ENVEOF
HV_HOST=127.0.0.1
HV_PORT=3000
HV_DATA_DIR=$REMOTE_DIR/data
HV_BACKUP_DIR=$REMOTE_DIR/backup
HV_LOG_DIR=$REMOTE_DIR/logs
HV_ADMIN_USER=admin
HV_ADMIN_PASS=\$ADMIN_PASS
HV_SEED_PUBLIC_CODES=20
HV_ADMIN_MAX_FAILS=5
HV_ADMIN_LOCK_MINUTES=60
HV_SESSION_HOURS=12
HV_MAX_UPLOAD=8388608
HV_LOG_LEVEL=info
ENVEOF
  chmod 600 .env
  echo "· 已生成 .env（管理员初始密码已写入，首次启动后见 $REMOTE_DIR/data/INITIAL_ADMIN.txt）"
fi

chown -R hostvote:hostvote $REMOTE_DIR
echo "· 安装生产依赖 ..."
runuser -u hostvote -- env HOME=$REMOTE_DIR bash -c 'cd $REMOTE_DIR/app && npm ci --omit=dev --no-audit --no-fund' 2>&1 | tail -3

echo "· 重启服务 ..."
systemctl daemon-reload
systemctl enable $SERVICE >/dev/null 2>&1 || true
systemctl restart $SERVICE
sleep 3
systemctl is-active $SERVICE
EOF
  c_ok "代码已发布，服务已重启"
  do_verify
}

# ------------------------------------------------------------------- verify ---
do_verify() {
  require_key
  c_info "验收检查 ..."
  SSH "bash -s" <<EOF
set -e
echo "--- 服务状态 ---"
systemctl is-active $SERVICE && systemctl status $SERVICE --no-pager | head -6 || true
echo "--- 本机端口 ---"
ss -lntp | grep -E ':(80|8080|3000)\b' || true
echo "--- 应用健康检查（内网 3000）---"
curl -s -m 5 http://127.0.0.1:3000/healthz; echo
echo "--- 经 Nginx 80 ---"
curl -s -m 5 -o /dev/null -w 'HTTP %{http_code}\n' http://127.0.0.1/healthz
echo "--- 经 Nginx 8080 ---"
curl -s -m 5 -o /dev/null -w 'HTTP %{http_code}\n' http://127.0.0.1:8080/healthz
echo "--- 数据库 ---"
ls -la $REMOTE_DIR/data/ | head -8
EOF
  c_info "从本机测试外网可达性 ..."
  for port in 80 8080; do
    code=$(curl -s -m 10 -o /dev/null -w '%{http_code}' "http://$PUBLIC_IP:$port/healthz" || echo "000")
    if [ "$code" = "200" ]; then c_ok "http://$PUBLIC_IP:$port/ 可访问（HTTP $code）"; else c_warn "http://$PUBLIC_IP:$port/ 返回 $code"; fi
  done
}

# --------------------------------------------------------------------- logs ---
do_logs() {
  require_key
  SSH "tail -n 80 $REMOTE_DIR/logs/app.log; echo '--- err ---'; tail -n 40 $REMOTE_DIR/logs/app.err.log 2>/dev/null || true"
}

# ------------------------------------------------------------------- backup ---
do_backup() {
  require_key
  SSH "runuser -u hostvote -- $NODE_BIN $REMOTE_DIR/app/scripts/backup.mjs"
}

case "${1:-push}" in
  bootstrap) do_bootstrap ;;
  push)      do_push ;;
  verify)    do_verify ;;
  logs)      do_logs ;;
  backup)    do_backup ;;
  *)
    echo "用法：$0 {bootstrap|push|verify|logs|backup}"
    exit 1
    ;;
esac
