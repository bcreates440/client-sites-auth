// Run: node test.mjs — checks the two things that keep editor tokens safe:
// the state cookie round-trip, and that only ALLOWED_ORIGINS get the token.
import assert from "node:assert";
import vm from "node:vm";
import worker from "./src/index.js";

const env = { GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret" };
const W = "https://client-sites-auth.example.workers.dev";

// /auth sets a state cookie matching the state sent to GitHub
const auth = await worker.fetch(new Request(W + "/auth"), env);
assert.equal(auth.status, 302);
const state = new URL(auth.headers.get("location")).searchParams.get("state");
assert.match(auth.headers.get("set-cookie"), new RegExp("oauth_state=" + state));

// /callback with a wrong or missing state never reaches GitHub
globalThis.fetch = async () => new Response(JSON.stringify({ access_token: "TOKEN" }));
const bad = await worker.fetch(new Request(W + "/callback?code=c&state=" + state), env);
assert.doesNotMatch(await bad.text(), /TOKEN/);

const good = await worker.fetch(
  new Request(W + "/callback?code=c&state=" + state, { headers: { cookie: "oauth_state=" + state } }),
  env
);
const script = (await good.text()).match(/<script>([\s\S]*)<\/script>/)[1];

// Run the popup script; see who it hands the token to
function popup(origin) {
  const sent = [];
  let listener;
  vm.runInNewContext(script, {
    window: {
      opener: { postMessage: (msg, to) => sent.push([msg, to]) },
      addEventListener: (_, fn) => (listener = fn),
      removeEventListener() {},
      close() {},
    },
  });
  listener({ origin });
  return sent.filter(([msg]) => msg.includes("TOKEN"));
}
assert.equal(popup("https://evil.example").length, 0);
assert.deepEqual(popup("https://wwcashow.com")[0][1], "https://wwcashow.com");

console.log("ok");
