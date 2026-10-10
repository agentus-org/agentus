#!/usr/bin/env bash
# Agentus 改名落地（LIVE :8788）—— 只有操作者明确下令才跑。
#
# 为什么需要单独一步（而不是直接 promote）：这次改名同时动了三样 live 正在用的东西，
# 任何一样漏掉都会静默出事：
#
#   1. 库文件名。index.ts 现在开的是 <data>/agentus.sqlite，而 live 的库叫
#      agentslot.sqlite —— 直接重启 = 开一个空库 = 操作者的会话列表凭空消失。
#   2. 启动器目录。live 的启动器在 ~/.hermes/cache/agentslot/launch.py，它 set 的
#      AGENTSLOT_* 变量改名后不再被代码读取（代码只认 AGENTUS_*）；不换 = 端口/数据目录
#      全部回落到默认值（8788/.data 恰好同值躲过一劫，TLS 与 HERMES_CMD 不会）。
#   3. 启动形态。dev 树里 scripts/start.sh、package.json、npm workspace 名字都变了，
#      需要 npm install 重连 @agentus/* 链接 + 重新 build。
#
# 顺序刻意这样排：先把「不需要进程配合」的事做完（启动器改名、代码 promote + 构建），
# 此时 live 仍用内存里的旧代码在跑、不掉线；然后才 kill -> 改库名 -> 用新启动器拉起，
# 停机窗口只有几秒。
#
#   bash scripts/apply-agentus-rename-live.sh --dry-run     # 只看要做什么
#   bash scripts/apply-agentus-rename-live.sh               # 真做（会重启 :8788）
#
# 前置：dev 树已 commit + push；dev 全套 sweep 已绿。
set -euo pipefail

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

HERE="$(cd "$(dirname "$0")/.." && pwd)"                       # dev 树
# live 树：2026-10-08 起两棵 worktree 已改名为 agentus / agentus-dev（本脚本自己那轮只改了
# 启动器目录与库文件名，故意没动 worktree 目录名；这次由人工序列补上）。
LIVE="${LIVE_REPO:-$(cd "$HERE/.." && pwd)/agentus}"             # live 树
LIVE_PORT="${LIVE_PORT:-8788}"
LIVE_TLS_PORT="${LIVE_TLS_PORT:-8443}"
LOLD="$HOME/.hermes/cache/agentslot"                            # 旧启动器目录
LNEW="$HOME/.hermes/cache/agentus"                              # 新启动器目录
SLUG="$(git -C "$HERE" rev-parse --abbrev-ref HEAD | tr '/' '-')"
DATA="$LIVE/packages/server/.data"
TOKEN="$DATA/auth.token"

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
run()  { if [ "$DRY" = 1 ]; then echo "  [dry] $*"; else eval "$@"; fi; }
die()  { echo "FAILED: $*" >&2; exit 1; }
pid_on() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1; }
api() { curl -s --noproxy '*' -m 8 -H "Authorization: Bearer $(cat "$TOKEN" 2>/dev/null)" "$@"; }
# 会话可能出现在 live（有 agent 在跑）或 archived（agent 已经没了 —— 重启之后，原来 live 的那些
# 就在这一类里）。两个都要看，否则"会话列表还在"这条检查会退化成 0>=0 的空转（2026-10-08 实测）。
allsids() { api "http://127.0.0.1:$LIVE_PORT/api/sessions" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log([...(j.live||[]),...(j.archived||[])].map(x=>x.id).join("\n"))}catch{console.log("")}})'; }
# 要恢复的 = 重启前【正在跑】的那些（就是这次重启会杀掉的那些）。别用"live+archived 里所有非 closed"：
# 那个口径会把历史上早已死掉的几十条冷会话一起拉起来（实测 dry-run 列出 19 个 id，含远古 QA 会话），
# 每条都要 spawn 一个 agent、大多注定失败。冷会话留给操作者在座舱里按需点恢复。
resumeids() { api "http://127.0.0.1:$LIVE_PORT/api/sessions" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log((j.live||[]).map(x=>x.id).join("\n"))}catch{console.log("")}})'; }
# 冷会话（archived 里非 closed）只报数，不自动恢复。
coldcount() { api "http://127.0.0.1:$LIVE_PORT/api/sessions" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log((j.archived||[]).filter(x=>x.status!=="closed").length)}catch{console.log("0")}})'; }

# ── 0. 前置检查 ──────────────────────────────────────────────────────────────
say "0. 前置检查"
[ -d "$LIVE" ] || die "live 树不存在: $LIVE"
# 可续跑：上一次可能停在中间（目录已迁、live 未重启）。旧目录没了但新目录在 = 续跑。
if [ -f "$LOLD/launch.py" ]; then
  RESUME=0
elif [ -f "$LNEW/launch.py" ]; then
  RESUME=1
  echo "  注意：$LOLD 已不在，而 $LNEW/launch.py 在 —— 按「续跑」处理（跳过目录改名）"
else
  die "两处都没有 launch.py（旧: $LOLD，新: $LNEW）"
fi
LIVE_PID="$(pid_on "$LIVE_PORT" || true)"; [ -n "$LIVE_PID" ] || die ":$LIVE_PORT 没有监听的进程——live 没在跑，别用这个脚本"
git -C "$HERE" diff --quiet && git -C "$HERE" diff --cached --quiet || die "dev 树有未提交的改动，先 commit"
SESS_BEFORE="$(allsids | tr '\n' ' ')"
RESUME_BEFORE="$(resumeids | tr '\n' ' ')"
ASSET_BEFORE="$(curl -s --noproxy '*' -m 5 "http://127.0.0.1:$LIVE_PORT/api/version" || true)"
echo "  dev 分支 : $SLUG @ $(git -C "$HERE" rev-parse --short HEAD)"
echo "  live 树   : $LIVE  (pid $LIVE_PID)"
echo "  live 会话 : ${SESS_BEFORE:-（无）}"
echo "  待恢复    : ${RESUME_BEFORE:-（无）}（另有冷会话 $(coldcount) 条，座舱里按需点恢复）"
echo "  live 版本 : ${ASSET_BEFORE:-（取不到）}"
echo "  启动器    : $LOLD  ->  $LNEW"

# ── 1. 启动器目录改名 + AGENTSLOT_* -> AGENTUS_* ─────────────────────────────
say "1. 启动器目录改名（${LOLD} -> ${LNEW}）"
if [ -d "$LNEW" ]; then
  echo "  ${LNEW} 已存在——跳过移动（假定上次已经迁过）"
else
  run "mv '$LOLD' '$LNEW'"
fi
# 里面的脚本：AGENTSLOT_ 前缀换掉、cache/agentslot 路径换掉；worktrees/agentslot 的引用一律
# 保留（本次不改 worktree 目录名，见报告）。逻辑在 scripts/agentus-rename-launcher-dir.py，
# 已用真实目录的副本验过（86 个文件改净、0 残留、worktree 引用完好）。
run "python3 '$HERE/scripts/agentus-rename-launcher-dir.py' '$LNEW'"
# 1b. 反向护栏：新启动器只认自己 pin 的那几个键，绝不吃调用者环境里带进来的身份
#     （2026-10-07 事故就是「身份跟着环境走」；见 track §64）。幂等。
run "python3 '$HERE/scripts/agentus-harden-launcher.py' '$LNEW/launch.py'"
if [ "$DRY" = 0 ]; then
  LEFT="$(grep -rl 'AGENTSLOT' "$LNEW" 2>/dev/null | head -5 || true)"
  [ -z "$LEFT" ] || die "启动器目录里仍有 AGENTSLOT：$LEFT"
  grep -q 'identity hygiene' "$LNEW/launch.py" || die "新启动器没被加固（缺 identity hygiene 段）"
  echo "  启动器目录已清干净 + 已加固"
fi

# ── 2. promote 改名后的代码到 live 树（live 仍在跑旧代码，不掉线）─────────────
say "2. 把改名代码落到 live 树（checkout run/$SLUG + npm install + build）"
OLD_TIP="$(git -C "$LIVE" rev-parse HEAD)"
echo "  live 树 $OLD_TIP  ->  $(git -C "$HERE" rev-parse --short HEAD)"
run "git -C '$LIVE' checkout -B 'run/$SLUG' $(git -C "$HERE" rev-parse HEAD)"
# NODE_ENV 显式写死：本机全局是 production，npm 会跳过 devDependencies —— 而 live 是用
# node_modules/.bin/tsx 跑起来的（tsx 是 devDependency），装掉了就起不来。
run "cd '$LIVE' && NODE_ENV=development npm install --no-audit --no-fund"
run "cd '$LIVE' && NODE_ENV=development npm run build"
if [ "$DRY" = 0 ]; then
  [ -x "$LIVE/node_modules/.bin/tsx" ] || die "live 树里没有 tsx（devDependency 被 NODE_ENV=production 跳过了）"
  # 这两个脚本本身就是迁移工具，必然含旧名 —— 排除它们，否则检查会死在自己身上
  LEFT="$(grep -rl 'AGENTSLOT' "$LIVE" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist \
    --exclude-dir=.data --exclude-dir=.data-notify-testbed \
    --exclude='apply-agentus-*.sh' --exclude='agentus-rename-*.py' 2>/dev/null | head -5 || true)"
  [ -z "$LEFT" ] || die "live 树里仍有 AGENTSLOT：$LEFT"
  echo "  live 树文本已清干净"
fi

# ── 3. 停机 -> 库文件改名 -> 用新启动器拉起 ─────────────────────────────────
say "3. 重启 :${LIVE_PORT}（先停、改库名、再起）"
if [ "$DRY" = 1 ]; then
  echo "  [dry] 停掉 :$LIVE_PORT 的进程组（TERM，等端口释放，最多 20s）"
else
  # 整组 TERM：监听进程是 launcher 的子进程，只杀它会把 watcher/holder 留着
  _pid="$(pid_on "$LIVE_PORT")"
  if [ -n "$_pid" ]; then
    _pgid="$(ps -o pgid= -p "$_pid" | tr -d ' ')"
    kill -TERM -"$_pgid" 2>/dev/null || kill -TERM "$_pid" 2>/dev/null || true
    for _ in $(seq 1 40); do [ -z "$(pid_on "$LIVE_PORT")" ] && break; sleep 0.5; done
  fi
  [ -z "$(pid_on "$LIVE_PORT")" ] || die "端口 $LIVE_PORT 没释放"
  echo "  端口已释放"
fi

# 库文件 + 它的 WAL/SHM。这一条就是「会话列表不能丢」的全部保障。
say "3b. 库文件改名 agentslot.sqlite* -> agentus.sqlite*"
if [ -f "$DATA/agentus.sqlite" ]; then
  echo "  $DATA/agentus.sqlite 已存在——跳过（假定上次已迁过）"
elif [ "$DRY" = 1 ]; then
  echo "  [dry] mv $DATA/agentslot.sqlite{,-wal,-shm,.pre-fold.bak} -> agentus.sqlite*"
else
  for f in agentslot.sqlite agentslot.sqlite-wal agentslot.sqlite-shm agentslot.sqlite.pre-fold.bak; do
    if [ -e "$DATA/$f" ]; then
      mv "$DATA/$f" "$DATA/${f/agentslot.sqlite/agentus.sqlite}"
      echo "  renamed $f"
    fi
  done
fi

if [ "$DRY" = 0 ]; then
  [ -f "$DATA/agentus.sqlite" ] || die "改名后没看到 $DATA/agentus.sqlite——不要继续"
  echo "  库文件就位: $(ls -la "$DATA/agentus.sqlite" | awk '{print $5" bytes"}')"
fi

if [ "$DRY" = 1 ]; then
  say "dry-run 结束：上面就是要做的全部动作，真跑请去掉 --dry-run（会重启 :${LIVE_PORT}）"
  exit 0
fi

say "3c. 用新启动器拉起"
run "cd '$LIVE' && python3 '$LNEW/launch.py'"
NEW_PID=""
# `pid_on` returns non-zero while the port is still free, and `set -e` + `pipefail` would then
# kill this script SILENTLY on the first iteration (observed 2026-10-08: live came up fine, the
# script just stopped — no postcheck, no slot resume). Absence of a listener is expected here.
for _ in $(seq 1 120); do
  NEW_PID="$(pid_on "$LIVE_PORT" || true)"
  if [ -n "$NEW_PID" ] && curl -s --noproxy '*' -m 3 "http://127.0.0.1:$LIVE_PORT/healthz" | grep -q '"ok":true'; then
    break
  fi
  sleep 1
done
[ -n "$NEW_PID" ] || die ":$LIVE_PORT 没起来——看 /tmp/agentus-server.log"
[ "$NEW_PID" != "$LIVE_PID" ] || die "pid 没变（${NEW_PID}）——旧进程还在跑，发布没生效"
echo "  pid $LIVE_PID -> $NEW_PID  ✅ 是新进程"

# ── 3d. 后端注册表里的绝对路径 ───────────────────────────────────────────────
# 注册表行存的是绝对命令路径（为什么是绝对：见 dev.sh 里那段注释）。启动器目录改名之后，
# 还写着旧目录的行会让 hermes 槽位起不来 —— 实测 resume 全报
# `failed to spawn /Users/liang/.hermes/cache/agentslot/hermes-acp-src (no pid)`。
say "3d. 把注册表里指向旧启动器目录的行改到新目录"
if [ "$DRY" = 1 ]; then
  echo "  [dry] PATCH 每个 cmd/args 含 $LOLD 的 backend 行 -> $LNEW"
else
  ROW_IDS="$(api "http://127.0.0.1:$LIVE_PORT/api/backends" | OLD="$LOLD" node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{
      const rows=(JSON.parse(s).backends||[]);
      console.log(rows.filter(r=>JSON.stringify(r).includes(process.env.OLD)).map(r=>r.id).join("\n"));
    }catch{console.log("")}})')"
  if [ -z "$ROW_IDS" ]; then
    echo "  没有行指向旧目录（已迁过）"
  else
    for _id in $ROW_IDS; do
      api -X PATCH -H 'content-type: application/json' \
        -d "{\"cmd\":\"$LNEW/hermes-acp-src\"}" \
        "http://127.0.0.1:$LIVE_PORT/api/backends/$_id" >/dev/null
      echo "  re-pointed backend '$_id' -> $LNEW/hermes-acp-src"
    done
  fi
fi

# ── 4. 回读验证 ─────────────────────────────────────────────────────────────
say "4. 回读验证"
FAIL=0
ck() { if [ "$2" = 1 ]; then echo "  ok   $1"; else echo "  FAIL $1"; FAIL=1; fi; }

ENVS="$(ps eww -p "$NEW_PID" | tr ' ' '\n' | grep -E '^AGENT' | sort)"
echo "$ENVS" | sed 's/^/       /'
ck "新进程的环境变量全是 AGENTUS_*（没有 AGENTSLOT_*）" \
   "$([ -n "$(echo "$ENVS" | grep '^AGENTUS_')" ] && [ -z "$(echo "$ENVS" | grep '^AGENTSLOT_')" ] && echo 1 || echo 0)"
ck "数据目录仍是 live 的 .data（没被 QA 库顶掉）" \
   "$(echo "$ENVS" | grep -q "AGENTUS_DATA=$DATA$" && echo 1 || echo 0)"
ck "端口仍是 $LIVE_PORT" "$(echo "$ENVS" | grep -q "^AGENTUS_PORT=$LIVE_PORT$" && echo 1 || echo 0)"

SESS_AFTER="$(allsids | tr '\n' ' ')"
ck "会话列表还在（${SESS_BEFORE:-无} -> ${SESS_AFTER:-无}）" \
   "$([ "$(echo "${SESS_AFTER:-}" | wc -w)" -ge "$(echo "${SESS_BEFORE:-}" | wc -w)" ] && echo 1 || echo 0)"

ck "没有后端行还指着旧启动器目录（否则 hermes 槽位起不来）" \
   "$([ -z "$(api "http://127.0.0.1:$LIVE_PORT/api/backends" | OLD="$LOLD" node -e '
     let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{
       const rows=(JSON.parse(s).backends||[]);
       console.log(rows.filter(r=>JSON.stringify(r).includes(process.env.OLD)).map(r=>r.id).join(","));
     }catch{console.log("")}})')" ] && echo 1 || echo 0)"

ck "TLS 监听 $LIVE_TLS_PORT 在线" "$([ -n "$(pid_on "$LIVE_TLS_PORT")" ] && echo 1 || echo 0)"

TITLE="$(curl -s --noproxy '*' -m 5 "http://127.0.0.1:$LIVE_PORT/" | grep -o '<title>[^<]*' | head -1 | sed 's/<title>//')"
ck "页面标题是 Agentus（实得: ${TITLE:-空}）" "$(echo "$TITLE" | grep -q 'Agentus' && echo 1 || echo 0)"

LEFT="$(grep -rl 'AGENTSLOT' "$LIVE" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist \
  --exclude-dir=.data --exclude-dir=.data-notify-testbed \
  --exclude='apply-agentus-*.sh' --exclude='agentus-rename-*.py' 2>/dev/null | head -3 || true)"
ck "live 树全文无 AGENTSLOT（残留: ${LEFT:-无}）" "$([ -z "$LEFT" ] && echo 1 || echo 0)"

ck "旧日志路径未再被写入（/tmp/agentus-server.log 新鲜）" \
   "$([ -n "$(find /tmp/agentus-server.log -newermt '-3 minutes' 2>/dev/null)" ] && echo 1 || echo 0)"

# ── 5. 槽位恢复 ─────────────────────────────────────────────────────────────
say "5. 把每个 live 槽位恢复（重启杀掉了它们的 agent 子进程）"
for id in $RESUME_BEFORE; do
  code="$(api -o /dev/null -w '%{http_code}' -X POST -m 90 "http://127.0.0.1:$LIVE_PORT/api/sessions/$id/resume" || true)"
  echo "  resume $id -> HTTP $code"
done

say "结果"
if [ "$FAIL" = 0 ]; then
  echo "  改名已在 live 生效。硬刷新座舱标签页（web 资产 hash 变了）。"
  echo "  剩下的：Android APK 需重编重装（applicationId 从 app.agentslot.companion 变 app.agentus.companion）——手机上的旧 App 仍是旧包名。"
  exit 0
else
  echo "  有 FAIL 项——live 可能不完整，回滚办法："
  echo "    git -C '$LIVE' checkout $OLD_TIP && (cd '$LIVE' && npm run build)"
  echo "    mv '$LNEW' '$LOLD'; mv '$DATA/agentus.sqlite'* 回 agentslot.sqlite*; python3 '$LOLD/launch.py'"
  exit 1
fi
