// AgentSlot auth — one operator, two credentials.
//
//   1. session cookie  : HttpOnly + SameSite=Lax, HMAC-SHA256 signed, minted by
//                        POST /api/auth/login. This is what the browser carries.
//   2. machine token   : 32-byte hex in <DATA_DIR>/auth.token (0600), accepted as
//                        `Authorization: Bearer <t>` or `?token=<t>`. Scripts,
//                        launchers and CI use this; no password on disk.
//
// Why a cookie and not the bearer-in-localStorage that hermes-studio's client uses
// (studied, not copied — packages/server/src/middleware/user-auth.ts): the cockpit
// spawns processes that can write files, so an XSS-readable token is a bad trade.
// An HttpOnly cookie is unreadable from JS and rides along on the WS handshake for
// free. Scripts still get the bearer path, so nothing becomes un-scriptable.
//
// Threat model: this gates a LAN-exposed service that can execute agent commands in
// arbitrary working directories. It is a lock on the shed, not a bank vault — no
// TLS by default (a bare LAN IP cannot carry a trusted cert), so treat the operator
// password as LAN-trust, and keep the default off the network.
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const COOKIE_NAME = "agentslot_session";
const DEFAULT_USERNAME = "admin";
const DEFAULT_PASSWORD = "123456";
const SESSION_VERSION = "v1";

export interface AuthPrincipal {
  kind: "session" | "token";
  username: string;
  expiresAt: number | null;
  /** session id — lets the sessions list mark which row is the caller */
  jti?: string;
}

export interface AuthStatus {
  enabled: boolean;
  username: string;
  usingDefaultPassword: boolean;
  /** where the username/password in play came from */
  source: "saved" | "env" | "default";
  /** live sessions in the registry (advisory count for the boot log) */
  sessions: number;
  /** ISO path of the machine token, so the boot log can point scripts at it */
  tokenFile: string | null;
  sessionTtlMs: number;
}

interface LimiterEntry {
  fails: number;
  lockedUntil: number;
}

const limiter = new Map<string, LimiterEntry>();

function envNum(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** `AGENTSLOT_AUTH=off` opens the cockpit (local hacking only) — it says so loudly. */
export function authEnabled(): boolean {
  const v = String(process.env.AGENTSLOT_AUTH ?? "on").trim().toLowerCase();
  return !(v === "off" || v === "0" || v === "false" || v === "no");
}

export function configuredUsername(): string {
  return stored?.username ?? (String(process.env.AGENTSLOT_USERNAME ?? DEFAULT_USERNAME).trim() || DEFAULT_USERNAME);
}

function configuredPassword(): string {
  return process.env.AGENTSLOT_PASSWORD ?? DEFAULT_PASSWORD;
}

function usesDefaultPassword(): boolean {
  return !stored && !process.env.AGENTSLOT_PASSWORD && !process.env.AGENTSLOT_PASSWORD_HASH;
}

/** Where the credentials in play come from — the settings page names the source, the
 *  same way the context-window popover names where its number came from. */
export function credentialSource(): "saved" | "env" | "default" {
  if (stored) return "saved";
  return process.env.AGENTSLOT_PASSWORD || process.env.AGENTSLOT_PASSWORD_HASH ? "env" : "default";
}

/** Bumped on every credential change and carried in the session payload, so a password
 *  change invalidates every cookie that was minted before it. */
export function credentialEpoch(): number {
  return stored?.epoch ?? 0;
}

/** scrypt:<salt>:<hex> — the shape hermes-studio writes, and what AGENTSLOT_PASSWORD_HASH takes. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  return `scrypt:${salt}:${scryptSync(password, salt, 32).toString("hex")}`;
}

export const MIN_PASSWORD_LEN = 6;
export const MIN_USERNAME_LEN = 2;

interface StoredCreds {
  username: string;
  /** scrypt:<salt>:<hex> — never the password itself */
  hash: string;
  epoch: number;
  updatedAt: number;
}

let stored: StoredCreds | null = null;
let credsFile: string | null = null;

function readStored(file: string): StoredCreds | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<StoredCreds>;
    if (!raw.username || !raw.hash || !String(raw.hash).startsWith("scrypt:")) return null;
    return {
      username: String(raw.username).trim(),
      hash: String(raw.hash),
      epoch: Number(raw.epoch ?? 1) || 1,
      updatedAt: Number(raw.updatedAt ?? 0),
    };
  } catch { return null; }
}

export type CredentialResult =
  | { ok: true; username: string; epoch: number }
  | { ok: false; status: number; error: string };

/**
 * Change the operator's credentials. The current password is required even though the
 * caller already holds a session: a session can be stolen, and this is the one action
 * that hands the whole cockpit over. On success every existing cookie stops validating
 * (the epoch moves) — the caller gets a fresh one from the endpoint.
 */
export function changeCredentials(input: { currentPassword: string; username?: string; newPassword?: string }): CredentialResult {
  if (!verifyCredentials(configuredUsername(), String(input.currentPassword ?? ""))) {
    return { ok: false, status: 401, error: "current password is not right" };
  }
  if (input.username === undefined && input.newPassword === undefined) {
    return { ok: false, status: 400, error: "nothing to change" };
  }
  const nextUser = input.username === undefined ? configuredUsername() : String(input.username).trim();
  if (nextUser.length < MIN_USERNAME_LEN || nextUser.length > 32 || /\s/.test(nextUser)) {
    return { ok: false, status: 400, error: `username must be ${MIN_USERNAME_LEN}-32 characters with no spaces` };
  }
  const newPass = input.newPassword === undefined ? null : String(input.newPassword);
  if (newPass !== null && newPass.length < MIN_PASSWORD_LEN) {
    return { ok: false, status: 400, error: `password must be at least ${MIN_PASSWORD_LEN} characters` };
  }
  if (!credsFile) return { ok: false, status: 500, error: "credentials are not initialised" };
  const next: StoredCreds = {
    username: nextUser,
    // a username-only change has to pin today's password as a hash, or the env value
    // would silently come back into play
    hash: newPass === null ? (stored?.hash ?? hashPassword(configuredPassword())) : hashPassword(newPass),
    epoch: (stored?.epoch ?? 0) + 1,
    updatedAt: Date.now(),
  };
  fs.mkdirSync(path.dirname(credsFile), { recursive: true });
  fs.writeFileSync(credsFile, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  stored = next;
  return { ok: true, username: next.username, epoch: next.epoch };
}

export function sessionTtlMs(): number {
  // NB: sessions carry a JWT-style `exp` stamped in whole SECONDS, so a TTL below
  // 1s can expire in the same second it was issued. Anything sane (hours/days) is fine.
  return envNum("AGENTSLOT_SESSION_TTL_MS", 1000 * 60 * 60 * 24 * 7); // 7 days
}

// ---- key material -----------------------------------------------------------

let secret: Buffer | null = null;
let tokenFile: string | null = null;
let machineToken: string | null = null;

function readOrCreate(file: string, bytes: number): string {
  try {
    const v = fs.readFileSync(file, "utf8").trim();
    if (v) return v;
  } catch { /* missing or unreadable => mint a new one */ }
  const value = randomBytes(bytes).toString("hex");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${value}\n`, { mode: 0o600 });
  return value;
}

/**
 * Load key material once at boot. Both files are 0600 and live next to the store,
 * so a restart keeps existing sessions valid (no surprise logout) and the machine
 * token stays stable for scripts.
 */
export function initAuth(dataDir: string): AuthStatus {
  // Credentials the operator changed in the UI win over the environment; the env pair
  // stays the bootstrap, exactly like voice/theme settings (settings.json > .env).
  credsFile = path.join(dataDir, "credentials.json");
  stored = readStored(credsFile);
  sessionsFile = path.join(dataDir, "sessions.json");
  adoptingLegacy = !fs.existsSync(sessionsFile);
  records = readRecords(sessionsFile);
  const secretRaw = process.env.AGENTSLOT_AUTH_SECRET?.trim() || readOrCreate(path.join(dataDir, "auth.secret"), 32);
  secret = Buffer.from(secretRaw, "utf8");
  // Exported so WS-upgrade code (a different module, same process) can verify too.
  const envToken = process.env.AGENTSLOT_AUTH_TOKEN?.trim();
  if (envToken) {
    tokenFile = null;
    machineToken = envToken;
  } else {
    tokenFile = path.join(dataDir, "auth.token");
    machineToken = readOrCreate(tokenFile, 32);
  }
  return status();
}

export function status(): AuthStatus {
  return {
    enabled: authEnabled(),
    username: configuredUsername(),
    usingDefaultPassword: usesDefaultPassword(),
    source: credentialSource(),
    sessions: records.length,
    tokenFile,
    sessionTtlMs: sessionTtlMs(),
  };
}

function hmac(input: string): string {
  return createHmac("sha256", secret ?? Buffer.from("uninitialised")).update(input).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** scrypt compare against `scrypt:<salt>:<hex>` (same on-disk shape hermes-studio uses). */
function verifyScrypt(password: string, stored: string): boolean {
  const [scheme, salt, expectedHex] = stored.split(":");
  if (scheme !== "scrypt" || !salt || !expectedHex) return false;
  const expected = Buffer.from(expectedHex, "hex");
  if (expected.length === 0) return false;
  const actual = scryptSync(password, salt, expected.length);
  return timingSafeEqual(actual, expected);
}

export function verifyCredentials(username: string, password: string): boolean {
  // Both sides are hashed before comparison: equal lengths (so timingSafeEqual is
  // usable) and no plaintext string identity check anywhere on the path.
  const userOk = safeEqual(
    createHash("sha256").update(String(username)).digest("hex"),
    createHash("sha256").update(configuredUsername()).digest("hex"),
  );
  // saved (UI-set) > AGENTSLOT_PASSWORD_HASH > AGENTSLOT_PASSWORD > built-in default
  const hashEnv = process.env.AGENTSLOT_PASSWORD_HASH?.trim();
  const hash = stored?.hash ?? hashEnv;
  const passOk = hash ? verifyScrypt(String(password), hash) : safeEqual(
    createHash("sha256").update(String(password)).digest("hex"),
    createHash("sha256").update(configuredPassword()).digest("hex"),
  );
  return userOk && passOk;
}

// ---- session tokens ---------------------------------------------------------

interface SessionBody {
  u: string;
  iat: number;
  exp: number;
  /** credential epoch: a password change moves it, so old cookies stop validating */
  e: number;
  /** session id — needed so "log out" can actually revoke, not just clear the cookie */
  jti: string;
}

/** Revoked session ids (in memory: a restart forgets, which also invalidates nothing —
 *  every cookie still has to pass signature+expiry on its own). */
const revoked = new Set<string>();
const REVOKED_CAP = 1000;

export function issueSession(
  username: string,
  now = Date.now(),
  origin: { ip?: string; ua?: string } = {},
): { value: string; expiresAt: number; jti: string } {
  const exp = now + sessionTtlMs();
  const payload: SessionBody = {
    u: username,
    iat: Math.floor(now / 1000),
    exp: Math.floor(exp / 1000),
    e: credentialEpoch(),
    jti: randomBytes(8).toString("hex"),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  // Recorded so the operator can SEE the devices holding a session and kick one. The
  // index is advisory for reads but authoritative for existence: a token whose jti is
  // not in the registry is refused (that is what makes "log out everywhere" real).
  rememberSession({
    jti: payload.jti,
    username,
    ip: String(origin.ip ?? ""),
    ua: String(origin.ua ?? "").slice(0, 240),
    iat: now,
    exp,
    lastSeen: now,
  });
  return { value: `${SESSION_VERSION}.${body}.${hmac(body)}`, expiresAt: exp, jti: payload.jti };
}

/** signature + expiry, ignoring revocation (revoke itself has to be able to parse) */
function parseSession(value: string | undefined | null, now = Date.now()): SessionBody | null {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== SESSION_VERSION) return null;
  const [, body, sig] = parts;
  if (!safeEqual(sig, hmac(body))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<SessionBody>;
    if (!parsed.u || !parsed.exp || !parsed.jti) return null;
    if (Math.floor(now / 1000) >= parsed.exp) return null;
    if (!safeEqual(String(parsed.u), configuredUsername())) return null; // username changed => old cookie dies
    if (Number(parsed.e ?? 0) !== credentialEpoch()) return null;          // password changed => same
    return parsed as SessionBody;
  } catch {
    return null;
  }
}

export function verifySessionValue(value: string | undefined | null, now = Date.now()): SessionBody | null {
  const body = parseSession(value, now);
  if (!body) return null;
  if (revoked.has(body.jti)) return null;
  if (!sessionKnown(body.jti)) {
    // First boot after this feature shipped: the registry did not exist yet, so a cookie
    // that still passes signature+expiry is adopted instead of logging every device out.
    if (!adoptingLegacy) return null;
    rememberSession({ jti: body.jti, username: body.u, ip: "", ua: "", iat: body.iat * 1000, exp: body.exp * 1000, lastSeen: now });
    adoptingLegacy = false;
  } else {
    noteSessionSeen(body.jti, now);
  }
  return body;
}

/** Logout with teeth: without this the stateless cookie would keep working until exp,
 *  so "sign out" would only hide the UI. */
export function revokeSession(value: string | undefined | null, now = Date.now()): boolean {
  const body = parseSession(value, now);
  if (!body) return false;
  forgetSession(body.jti);
  rememberRevoked(body.jti);
  return true;
}

/** unbounded growth in a long-lived process is a slow leak; keep the recent tail */
function rememberRevoked(jti: string): void {
  revoked.add(jti);
  if (revoked.size > REVOKED_CAP) {
    const first = revoked.values().next().value;
    if (first) revoked.delete(first);
  }
}

// ---- the session registry: who is signed in, and from where ------------------
//
// Sessions are stateless (HMAC + expiry), which is exactly why they are invisible: a
// stolen cookie or a phone left logged in on a train cannot be seen, let alone revoked.
// This registry is the index the operator looks at and kicks from. It is advisory for
// reads, authoritative for existence — a valid-looking cookie whose jti is absent is
// refused, so "log out everywhere" survives a restart.
//
// Left over from hermes-studio (studied, not copied): their AccountSettings lists locked
// IPs and hands you an unlock button. We have had a login limiter since M1 with no way to
// look at it — same gap, same fix.

interface SessionRecord {
  jti: string;
  username: string;
  ip: string;
  ua: string;
  iat: number;
  exp: number;
  lastSeen: number;
}

let sessionsFile: string | null = null;
let records: SessionRecord[] = [];
/** true only until the registry exists on disk: valid cookies from before the upgrade
 *  are adopted once instead of logging every device out. */
let adoptingLegacy = true;
let lastFlush = 0;

function readRecords(file: string): SessionRecord[] {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as SessionRecord[];
    if (!Array.isArray(raw)) return [];
    return raw.filter((r) => r && typeof r.jti === "string" && Number(r.exp) > 0);
  } catch { return []; }
}

function flushSessions(force = false): void {
  if (!sessionsFile) return;
  const now = Date.now();
  if (!force && now - lastFlush < 20000) return; // lastSeen ticks are not worth a write each
  lastFlush = now;
  records = records.filter((r) => r.exp > now);
  fs.mkdirSync(path.dirname(sessionsFile), { recursive: true });
  fs.writeFileSync(sessionsFile, `${JSON.stringify(records)}
`, { mode: 0o600 });
  adoptingLegacy = false;
}

function rememberSession(r: SessionRecord): void {
  records = records.filter((x) => x.jti !== r.jti);
  records.push(r);
  flushSessions(true);
}

function sessionKnown(jti: string): boolean {
  return records.some((r) => r.jti === jti);
}

function noteSessionSeen(jti: string, now: number): void {
  const r = records.find((x) => x.jti === jti);
  if (!r) return;
  r.lastSeen = now;
  flushSessions();
}

function forgetSession(jti: string): void {
  const before = records.length;
  records = records.filter((r) => r.jti !== jti);
  if (records.length !== before) flushSessions(true);
}

export interface SessionView {
  jti: string;
  username: string;
  ip: string;
  ua: string;
  issuedAt: number;
  expiresAt: number;
  lastSeen: number;
  current: boolean;
}

export function listSessions(currentJti?: string, now = Date.now()): SessionView[] {
  return records
    .filter((r) => r.exp > now && !revoked.has(r.jti))
    .map((r) => ({
      jti: r.jti,
      username: r.username,
      ip: r.ip,
      ua: r.ua,
      issuedAt: r.iat,
      expiresAt: r.exp,
      lastSeen: r.lastSeen,
      current: Boolean(currentJti) && r.jti === currentJti,
    }))
    .sort((a, b) => Number(b.current) - Number(a.current) || b.lastSeen - a.lastSeen);
}

/** Kill one device's session. Returns false when the id is not a live session. */
export function revokeSessionById(jti: string): boolean {
  if (!jti || !sessionKnown(jti)) return false;
  forgetSession(jti);
  rememberRevoked(jti);
  return true;
}

/** Log out everywhere except the caller. Returns how many sessions were dropped. */
export function revokeOtherSessions(keepJti: string | undefined): number {
  const now = Date.now();
  const victims = records.filter((r) => r.jti !== keepJti && r.exp > now);
  for (const v of victims) {
    forgetSession(v.jti);
    rememberRevoked(v.jti);
  }
  return victims.length;
}

// ---- login-failure locks, visible and liftable ------------------------------

export interface IpLockView {
  ip: string;
  fails: number;
  locked: boolean;
  retryAfterMs: number;
}

export function listIpLocks(now = Date.now()): IpLockView[] {
  const out: IpLockView[] = [];
  for (const [ip, e] of limiter) {
    const locked = e.lockedUntil > now;
    if (!locked && e.fails === 0) continue;
    out.push({ ip, fails: e.fails, locked, retryAfterMs: locked ? e.lockedUntil - now : 0 });
  }
  return out.sort((a, b) => Number(b.locked) - Number(a.locked) || b.fails - a.fails);
}

/** Lift a lock (or clear a half-spent failure count). False when the IP was not known. */
export function unlockIp(ip: string): boolean {
  return limiter.delete(ip);
}

export function unlockAllIps(): number {
  const n = limiter.size;
  limiter.clear();
  return n;
}

export function verifyMachineToken(value: string | undefined | null): boolean {
  if (!value || !machineToken || !authEnabled()) return false;
  return safeEqual(String(value), machineToken);
}

// ---- request plumbing -------------------------------------------------------

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(header ?? "").split(";")) {
    const idx = part.indexOf("=");
    if (idx < 1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function bearer(header: string | string[] | undefined): string {
  const raw = Array.isArray(header) ? header[0] : header;
  const s = String(raw ?? "");
  return s.toLowerCase().startsWith("bearer ") ? s.slice(7).trim() : "";
}

/**
 * Resolve the caller. Returns null when unauthenticated (caller decides the status
 * code). Disabled auth => an anonymous operator, so local dev stays frictionless.
 */
export function authenticate(
  headers: Record<string, string | string[] | undefined>,
  url: URL,
  now = Date.now(),
): AuthPrincipal | null {
  const st = status();
  if (!st.enabled) return { kind: "token", username: st.username, expiresAt: null };

  const token = bearer(headers.authorization) || url.searchParams.get("token") || "";
  if (verifyMachineToken(token)) return { kind: "token", username: st.username, expiresAt: null };

  const session = verifySessionValue(parseCookies(String(headers.cookie ?? ""))[COOKIE_NAME], now);
  if (session) return { kind: "session", username: session.u, expiresAt: session.exp * 1000, jti: session.jti };

  return null;
}

/** `/api/auth/*` is reachable unauthenticated; the SPA shell and assets are public. */
const PUBLIC_API = new Set(["/api/auth/login", "/api/auth/me", "/api/auth/logout"]);

export function requiresAuth(pathname: string): boolean {
  if (!pathname.startsWith("/api/")) return false; // shell, assets, /healthz
  return !PUBLIC_API.has(pathname);
}

export function isSecureRequest(headers: Record<string, string | string[] | undefined>): boolean {
  const proto = String(headers["x-forwarded-proto"] ?? "").split(",")[0].trim().toLowerCase();
  return proto === "https";
}

export function sessionCookie(value: string, maxAgeSec: number, secure: boolean): string {
  return [
    `${COOKIE_NAME}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSec}`,
    // Only over HTTPS: with a bare LAN IP there is no cert, and a Secure cookie
    // would simply never be stored (looks exactly like "login does nothing").
    secure ? "Secure" : "",
  ].filter(Boolean).join("; ");
}

export function clearedCookie(secure: boolean): string {
  return sessionCookie("", 0, secure);
}

// ---- login rate limit -------------------------------------------------------

/** 5 bad attempts from one IP => 30s lockout. Env-tunable so tests need not sleep. */
export function loginLimits(): { maxFails: number; lockMs: number } {
  return { maxFails: envNum("AGENTSLOT_LOGIN_MAX_FAILS", 5), lockMs: envNum("AGENTSLOT_LOGIN_LOCK_MS", 30_000) };
}

export function loginAllowed(ip: string, now = Date.now()): { allowed: boolean; retryAfterMs: number } {
  const e = limiter.get(ip);
  if (!e) return { allowed: true, retryAfterMs: 0 };
  if (e.lockedUntil > now) return { allowed: false, retryAfterMs: e.lockedUntil - now };
  return { allowed: true, retryAfterMs: 0 };
}

export function recordLoginFailure(ip: string, now = Date.now()): void {
  const { maxFails, lockMs } = loginLimits();
  const e = limiter.get(ip) ?? { fails: 0, lockedUntil: 0 };
  e.fails += 1;
  if (e.fails >= maxFails) {
    e.lockedUntil = now + lockMs;
    e.fails = 0;
  }
  limiter.set(ip, e);
}

export function recordLoginSuccess(ip: string): void {
  limiter.delete(ip);
}

/** test hook: QA drives lockout behaviour without waiting for real time */
export function resetLoginLimiter(): void {
  limiter.clear();
}

export const AUTH_COOKIE_NAME = COOKIE_NAME;
export const AUTH_DEFAULT_USERNAME = DEFAULT_USERNAME;
export const AUTH_DEFAULT_PASSWORD = DEFAULT_PASSWORD;

// ---- HTTP Basic (the outer lock) --------------------------------------------
//
// Why this exists at all: SakuraFrp's per-tunnel `auth_pass` turned out to gate HTTP
// with a 200 "authorise your IP" page rather than a 401 challenge — unscriptable, and
// invisible to curl. So the outer lock lives here: a standard Basic challenge in front
// of everything, which any tunnel, proxy or phone browser honours.
//
// AGENTSLOT_BASIC_AUTH forms:
//   user:pass   -> both must match
//   :pass       -> password only; ANY (or empty) username is accepted
//   pass        -> same as ":pass"
// Unset means no Basic layer (LAN/local default).
//
// The password-only form exists because HTTP Basic *always* asks for a username
// (RFC 7617 puts "user:pass" in the header), but a single-operator service has no
// use for one — typing any name, or leaving it blank, is friction with no security
// value. Note the trap this replaces: a naive parser that required a non-empty
// username would treat ":pass" as malformed and silently turn the lock OFF.

export function basicAuthConfig(): { user: string; pass: string } | null {
  const raw = process.env.AGENTSLOT_BASIC_AUTH?.trim();
  if (!raw) return null;
  const idx = raw.indexOf(":");
  const cfg = idx < 0 ? { user: "", pass: raw } : { user: raw.slice(0, idx), pass: raw.slice(idx + 1) };
  return cfg.pass ? cfg : null; // a password is mandatory; an empty one locks nobody out usefully
}

export function verifyBasic(header: string | string[] | undefined): boolean {
  const cfg = basicAuthConfig();
  if (!cfg) return true;
  const raw = Array.isArray(header) ? header[0] : header;
  const value = String(raw ?? "");
  if (!value.toLowerCase().startsWith("basic ")) return false;
  let decoded = "";
  try {
    decoded = Buffer.from(value.slice(6).trim(), "base64").toString("utf8");
  } catch {
    return false;
  }
  const idx = decoded.indexOf(":");
  if (idx < 0) return false;
  const givenUser = decoded.slice(0, idx);
  const givenPass = decoded.slice(idx + 1);
  const passOk = safeEqual(digest(givenPass), digest(cfg.pass));
  // no username configured => username is not part of the secret
  const userOk = cfg.user === "" ? true : safeEqual(digest(givenUser), digest(cfg.user));
  return userOk && passOk;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** 401 + the challenge. Without WWW-Authenticate a browser never asks. */
export function basicChallenge(): Record<string, string> {
  return {
    "www-authenticate": 'Basic realm="AgentSlot", charset="UTF-8"',
    "content-type": "text/plain; charset=utf-8",
  };
}
