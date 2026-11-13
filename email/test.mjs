// Run: node email/test.mjs - checks that only a real Access sign-in for a
// listed email gets a session, and that a session only reaches its own repo.
import assert from "node:assert";
import vm from "node:vm";
import worker, { makeSession } from "./index.js";

const b64url = (b) => Buffer.from(b).toString("base64url");
const kv = new Map([["client@example.com", "bcreates440/wwca-site"]]);
const env = {
  TEAM_DOMAIN: "team.cloudflareaccess.com", ACCESS_AUD: "AUD", GITHUB_TOKEN: "GHTOKEN", SESSION_SECRET: "s3cret",
  EDITORS: { get: async (k) => kv.get(k) ?? null },
};
const W = "https://client-sites-email.example.workers.dev";

// A fake Access signing key and the JWTs it would issue.
const { publicKey, privateKey } = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", publicKey)), kid: "k1" };
async function jwt(claims, key = privateKey) {
  const h = b64url(JSON.stringify({ alg: "RS256", kid: "k1" }));
  const p = b64url(JSON.stringify({ aud: ["AUD"], iss: "https://team.cloudflareaccess.com", exp: Date.now() / 1000 + 60, ...claims }));
  return `${h}.${p}.${b64url(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${h}.${p}`)))}`;
}

let calls = [];
globalThis.fetch = async (u, opts = {}) => {
  if (String(u).endsWith("/cdn-cgi/access/certs")) return new Response(JSON.stringify({ keys: [jwk] }));
  calls.push([String(u), opts]);
  return new Response("{}", { status: 200 });
};

async function login(token) {
  const res = await worker.fetch(new Request(W + "/login", { headers: token ? { "cf-access-jwt-assertion": token } : {} }), env);
  const script = (await res.text()).match(/<script>([\s\S]*)<\/script>/)[1];
  const sent = [];
  let listener;
  vm.runInNewContext(script, { window: { opener: { postMessage: (m, to) => sent.push([m, to]) }, addEventListener: (_, f) => (listener = f), removeEventListener() {}, close() {} } });
  listener({ origin: "https://wwcashow.com" });
  const evil = sent.length;
  listener({ origin: "https://evil.example" });
  assert.equal(sent.length, evil, "nothing sent to an unlisted site");
  return sent.map(([m]) => m).filter((m) => m.startsWith("authorization:")).join("");
}

// No Access token, a wrong audience, a forged signature, or an unlisted email: no session.
assert.doesNotMatch(await login(), /ses\./);
assert.doesNotMatch(await login(await jwt({ email: "client@example.com", aud: ["OTHER"] })), /ses\./);
const other = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign"]);
assert.doesNotMatch(await login(await jwt({ email: "client@example.com" }, other.privateKey)), /ses\./);
assert.match(await login(await jwt({ email: "stranger@example.com" })), /isn't set up/);

// A listed email gets a session.
const session = JSON.parse((await login(await jwt({ email: "Client@Example.com" }))).replace(/^authorization:github:success:/, "")).token;
assert.match(session, /^ses\./);

const api = (path, { token = session, method = "GET", body } = {}) =>
  worker.fetch(new Request(W + "/api" + path, { method, body, headers: { authorization: `Bearer ${token}`, origin: "https://wwcashow.com" } }), env);

// Own repo, editor calls: forwarded with Blake's token.
calls = [];
assert.equal((await api("/repos/bcreates440/wwca-site/branches/main")).status, 200);
assert.equal(calls[0][0], "https://api.github.com/repos/bcreates440/wwca-site/branches/main");
assert.equal(calls[0][1].headers.authorization, "Bearer GHTOKEN");

// Commits record who made them.
calls = [];
await api("/repos/bcreates440/wwca-site/git/commits", { method: "POST", body: JSON.stringify({ message: "m", tree: "t", parents: [] }) });
assert.deepEqual(JSON.parse(calls[0][1].body).author, { name: "client@example.com", email: "client@example.com" });

// Refused: another repo, a call the editor never makes, a delete, a tampered or expired session.
calls = [];
assert.equal((await api("/repos/bcreates440/jones-uncommon-site/branches/main")).status, 403);
assert.equal((await api("/repos/bcreates440/wwca-site/collaborators")).status, 403);
assert.equal((await api("/repos/bcreates440/wwca-site/git/refs/heads/main", { method: "DELETE" })).status, 403);
assert.equal((await api("/repos/bcreates440/wwca-site/branches/main", { token: session.slice(0, -2) + "xx" })).status, 401);
assert.equal((await api("/repos/bcreates440/wwca-site/branches/main", { token: await makeSession("client@example.com", env, Date.now() - 31 * 864e5) })).status, 401);
// Removing someone from EDITORS locks them out straight away.
kv.delete("client@example.com");
assert.equal((await api("/repos/bcreates440/wwca-site/branches/main")).status, 403);
assert.equal(calls.length, 0, "nothing refused ever reached GitHub");

console.log("ok");
