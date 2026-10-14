#!/usr/bin/env node
/**
 * The Android trust-store bug, reproduced where it can actually run: a real TLS handshake against a
 * server that chains to a root the client was NOT handed, then the same handshake against the
 * merged store.
 *
 * Issue #8: the companion app failed with "Trust anchor for certification path not found" on
 * servers the *browser* accepted. Two roots are involved and the app only ever consulted one:
 *
 *   * the system roots ("System Root" below) — what `TrustManagerFactory.init(null)` gives you, and
 *   * the operator's own root ("Operator Private Root") — installed on the device by hand, and kept
 *     OUT of a third-party app's default chain since Android 7. Chrome ships its own store, so
 *     "it opens fine in the browser" says nothing about the app.
 *
 * The fix merges the two (`Http.deviceManager()`); this file is the guard on the behaviour that
 * merge buys, so a future refactor cannot quietly drop it back to the system store alone.
 *
 *   node scripts/qa/android-trust-merge.mjs
 *
 * The client deliberately waives hostname verification, exactly as the app's
 * `hostnameVerifier((host, session) -> true)` does — the point under test is the trust ANCHOR, and
 * a hostname failure would mask it.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import https from 'node:https';

const dir = mkdtempSync(join(tmpdir(), 'agentus-trust-'));
let ok = 0, failed = 0;
const check = (name, pass, detail) => {
  if (pass) { ok++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ''}`); }
};

const run = (args, input) => execFileSync('openssl', args, { cwd: dir, input, stdio: ['pipe', 'pipe', 'pipe'] });
const f = (n) => join(dir, n);

try {
  console.log('== ① two roots, one of them only present in the "user" store ==');
  run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'sys.key', '-out', 'sys.crt',
       '-days', '3650', '-subj', '/CN=System Root (already trusted)']);
  run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'user.key', '-out', 'user.crt',
       '-days', '3650', '-subj', '/CN=Operator Private Root (user store)']);
  run(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr',
       '-subj', '/CN=agentus.example']);
  writeFileSync(f('ext.cnf'), 'subjectAltName=DNS:agentus.example\n');
  // the server's leaf is issued by the OPERATOR root, i.e. the one the default chain cannot see
  run(['x509', '-req', '-in', 'leaf.csr', '-CA', 'user.crt', '-CAkey', 'user.key', '-out', 'leaf.crt',
       '-days', '365', '-CAcreateserial', '-extfile', 'ext.cnf']);
  check(true, 'a server certificate issued by the operator root (not by the system root)');

  // the leaf first, then its issuer — the shape a server actually sends
  const serverCert = readFileSync(f('leaf.crt'), 'utf8') + readFileSync(f('user.crt'), 'utf8');
  const server = https.createServer({ key: readFileSync(f('leaf.key')), cert: serverCert }, (_q, s) => s.end('ok'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const connect = (cas) => new Promise((resolve) => {
    const req = https.get({
      host: '127.0.0.1', port, path: '/', ca: cas.map((c) => readFileSync(f(c))),
      servername: 'agentus.example', rejectUnauthorized: true,
      checkServerIdentity: () => undefined, // the app's own waived hostname; see the header
    }, (res) => { res.resume(); resolve({ ok: true, status: res.statusCode }); });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.setTimeout(6000, () => { req.destroy(new Error('timeout')); });
  });

  console.log('\n== ② BEFORE the fix: the system store alone (what the app used to do) ==');
  const before = await connect(['sys.crt']);
  check('the handshake is REFUSED — this is the reported bug, reproduced',
    before.ok === false, JSON.stringify(before));
  check('…and it is refused for the trust reason, not a timeout or a protocol error',
    /unable to (verify|get local issuer)|self[- ]signed/i.test(String(before.error)), String(before.error));

  console.log('\n== ③ AFTER the fix: system ∪ user store ==');
  const after = await connect(['sys.crt', 'user.crt']);
  check('the same chain now completes', after.ok === true, JSON.stringify(after));

  console.log('\n== ④ the merge is ADDITIVE, never a trust-all ==');
  // A root that is in NEITHER store must still be refused: the fix must not have widened the
  // anchor set to "anything that signs".
  run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'rogue.key', '-out', 'rogue.crt',
       '-days', '3650', '-subj', '/CN=Unrelated Root (never installed)']);
  run(['x509', '-req', '-in', 'leaf.csr', '-CA', 'rogue.crt', '-CAkey', 'rogue.key', '-out', 'rogue-leaf.crt',
       '-days', '365', '-CAcreateserial', '-extfile', 'ext.cnf']);
  const rogue = https.createServer(
    { key: readFileSync(f('leaf.key')),
      cert: readFileSync(f('rogue-leaf.crt'), 'utf8') + readFileSync(f('rogue.crt'), 'utf8') },
    (_q, s) => s.end('ok'),
  );
  await new Promise((r) => rogue.listen(0, '127.0.0.1', r));
  const roguePort = rogue.address().port;
  const rogueTry = await new Promise((resolve) => {
    const req = https.get({
      host: '127.0.0.1', port: roguePort, path: '/', ca: [readFileSync(f('sys.crt')), readFileSync(f('user.crt'))],
      servername: 'agentus.example', rejectUnauthorized: true, checkServerIdentity: () => undefined,
    }, (res) => { res.resume(); resolve({ ok: true }); });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.setTimeout(6000, () => req.destroy(new Error('timeout')));
  });
  check('a chain to a root in NEITHER store is still refused (no trust-all path)',
    rogueTry.ok === false, JSON.stringify(rogueTry));

  server.close(); rogue.close();
  console.log(`\n${ok} ok, ${failed} failed`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed === 0 ? 0 : 1);
