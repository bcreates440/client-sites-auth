/**
 * Email sign-in for the click-to-edit editor (/edit/), for clients who don't
 * have a GitHub account. Runs ALONGSIDE the GitHub sign-in (../src/index.js),
 * which keeps working unchanged.
 *
 *   /login   Behind Cloudflare Access (one-time code sent to the email).
 *            Access proves who the person is; this worker checks the EDITORS
 *            list and hands the editor a session in a popup, the same way
 *            the GitHub sign-in hands over a token.
 *   /api/... The editor's GitHub calls, made here with Blake's GitHub token,
 *            only for the repo(s) that email may edit, and only the calls
 *            the editor needs.
 *
 * Who may edit what lives in the EDITORS KV namespace (not in this public
 * repo): key = email in lower case, value = "owner/repo" (comma-separate
 * several). Delete the key and that person is locked out at once.
 *
 * Secrets: GITHUB_TOKEN (fine-grained, client repos only: Contents
 * read/write, Pages read) and SESSION_SECRET (any long random string).
 */
import { ALLOWED_ORIGINS } from "../src/origins.js";

const SESSION_DAYS = 30;
const enc = new TextEncoder();
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

// Every path the editor calls (edit/editor.js and edit/publish.js). Anything
// else - settings, collaborators, deleting the repo - is refused.
const ALLOWED_API = /^\/repos\/([\w.-]+\/[\w.-]+)\/(branches\/[^/]+|git\/(trees|blobs|commits)(\/[0-9a-f]{40})?|git\/refs\/heads\/[\w./-]+|contents\/[^?]+|commits|compare\/[0-9a-f]{40}\.\.\.[0-9a-f]{40}|pages\/builds\/latest)$/;

async function hmacKey(env) {
  return crypto.subtle.importKey("raw", enc.encode(env.SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function makeSession(email, env, now = Date.now()) {
  const body = b64url(enc.encode(JSON.stringify({ e: email, x: now + SESSION_DAYS * 864e5 })));
  return `ses.${body}.${b64url(await crypto.subtle.sign("HMAC", await hmacKey(env), enc.encode(body)))}`;
}

async function readSession(token, env) {
  const m = /^ses\.([\w-]+)\.([\w-]+)$/.exec(token || "");
  if (!m) return null;
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(env), unb64url(m[2]), enc.encode(m[1]));
  if (!ok) return null;
  const { e, x } = JSON.parse(new TextDecoder().decode(unb64url(m[1])));
  return x > Date.now() ? e : null;
}

async function reposFor(email, env) {
  const v = await env.EDITORS.get(String(email).toLowerCase());
  return v ? v.split(",").map((r) => r.trim().toLowerCase()).filter(Boolean) : [];
}

// Cloudflare Access puts a signed token on every request it lets through.
// Checking it here too means a mistake in the Access setup fails closed.
async function accessEmail(request, env) {
  const jwt = request.headers.get("cf-access-jwt-assertion");
  if (!jwt) return null;
  const [h, p, s] = jwt.split(".");
  const header = JSON.parse(new TextDecoder().decode(unb64url(h)));
  const { keys } = await (await fetch(`https://${env.TEAM_DOMAIN}/cdn-cgi/access/certs`)).json();
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, unb64url(s), enc.encode(`${h}.${p}`)))) return null;
  const claims = JSON.parse(new TextDecoder().decode(unb64url(p)));
  const aud = [].concat(claims.aud);
  if (!aud.includes(env.ACCESS_AUD) || claims.iss !== `https://${env.TEAM_DOMAIN}` || claims.exp * 1000 < Date.now()) return null;
  return claims.email || null;
}

// Same popup handshake as the GitHub sign-in, so the editor treats both alike.
function handshake(ok, data) {
  const message = "authorization:github:" + (ok ? "success" : "error") + ":" + JSON.stringify(data);
  const note = ok ? "Signing you in&hellip;" : data.error.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return new Response(
    '<!doctype html><meta charset="utf-8"><title>Signing in</title>' +
      '<body style="font:16px system-ui,sans-serif;padding:2rem;color:#14264F">' + note + "<script>(function(){" +
      "var allowed=" + JSON.stringify(ALLOWED_ORIGINS) + ";" +
      "function send(e){if(allowed.indexOf(e.origin)<0)return;" +
      "window.opener.postMessage(" + JSON.stringify(message) + ", e.origin);" +
      'window.removeEventListener("message", send, false);' + (ok ? "window.close();" : "") + "}" +
      'window.addEventListener("message", send, false);' +
      'if(window.opener)window.opener.postMessage("authorizing:github", "*");' +
      "})();</script>",
    { headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

function cors(request) {
  const origin = request.headers.get("origin");
  return ALLOWED_ORIGINS.includes(origin)
    ? { "access-control-allow-origin": origin, "access-control-allow-headers": "authorization, content-type, accept, x-github-api-version", "access-control-allow-methods": "GET, POST, PATCH", vary: "origin" }
    : {};
}

async function api(request, env, url) {
  const headers = cors(request);
  const deny = (status, message) => new Response(JSON.stringify({ message }), { status, headers: { ...headers, "content-type": "application/json" } });
  const email = await readSession((request.headers.get("authorization") || "").replace(/^Bearer /, ""), env);
  if (!email) return deny(401, "Signed out");
  const path = url.pathname.slice(4);
  const m = ALLOWED_API.exec(path);
  if (!m || !["GET", "POST", "PATCH"].includes(request.method)) return deny(403, "Not something the editor does");
  if (!(await reposFor(email, env)).includes(m[1].toLowerCase())) return deny(403, "This email can't edit that website");

  let body = request.method === "GET" ? undefined : await request.text();
  // Commits are made with Blake's token; record who actually made the change.
  if (request.method === "POST" && /^git\/commits$/.test(m[2])) {
    const commit = JSON.parse(body);
    commit.author = { name: email, email };
    body = JSON.stringify(commit);
  }
  const res = await fetch("https://api.github.com" + path + url.search, {
    method: request.method,
    body,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "client-sites-email",
      ...(body ? { "content-type": "application/json" } : {}),
    },
  });
  // A 401 from GitHub means Blake's token expired, not the client's sign-in.
  const status = res.status === 401 ? 502 : res.status;
  return new Response(res.body, { status, headers: { ...headers, "content-type": "application/json" } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request) });
    if (url.pathname.startsWith("/api/")) return api(request, env, url);

    if (url.pathname === "/login") {
      const email = await accessEmail(request, env).catch(() => null);
      if (!email) return handshake(false, { error: "Sign-in didn't finish. Close this window and try again." });
      if (!(await reposFor(email, env)).length) {
        return handshake(false, { error: `${email} isn't set up to edit a website yet. Ask Blake to add it, then try again.` });
      }
      return handshake(true, { token: await makeSession(email.toLowerCase(), env), provider: "github" });
    }
    return new Response("Client sites editor email sign-in.", { status: 404 });
  },
};
