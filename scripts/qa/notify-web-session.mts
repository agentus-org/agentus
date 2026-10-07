// QA helper: mint a browser session for the LOCAL cockpit so the web UI can be driven headless.
//
// It never sees or asks for the operator's password: initAuth() reads the stored credential file
// and issueSession() is the same call POST /api/auth/login would make. The session is recorded in
// the normal session registry (so it shows up in 设置 → 登录会话), and the printed jti is what the
// test revokes afterwards. Usage:
//   npx tsx scripts/qa/notify-web-session.mts            -> prints "name=value"
//   npx tsx scripts/qa/notify-web-session.mts --revoke <jti>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AUTH_COOKIE_NAME, configuredUsername, initAuth, issueSession, revokeSessionById } from "../../packages/server/src/auth.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.AGENTUS_DATA ?? path.resolve(HERE, "../../packages/server/.data");

if (!fs.existsSync(DATA)) {
  console.error(`no cockpit data dir at ${DATA}`);
  process.exit(1);
}
initAuth(DATA);

const revoke = process.argv.indexOf("--revoke");
if (revoke > 0) {
  const jti = process.argv[revoke + 1] ?? "";
  console.log(revokeSessionById(jti) ? `revoked ${jti}` : `no session ${jti}`);
  process.exit(0);
}

const session = issueSession(configuredUsername(), Date.now(), { ip: "127.0.0.1", ua: "notify-ui-qa" });
console.log(`${AUTH_COOKIE_NAME}=${session.value}`);
console.error(`jti=${session.jti} expires=${new Date(session.expiresAt).toISOString()}`);
