/**
 * GitHub sign-in for client website editors, on Cloudflare Workers.
 *
 * This is NOT a website. It's a small free service shared across every
 * client site's Decap CMS editor, doing the one thing GitHub Pages can't do
 * on its own: swap a GitHub login for an access token, so the editor can
 * save changes. It has no idea which repo the editor is saving to — GitHub
 * itself enforces that via each client's collaborator permissions.
 *
 * Two addresses matter:
 *   /auth       the editor sends you here to start signing in
 *   /callback   GitHub sends you back here afterwards
 *
 * The GitHub OAuth App's "Authorization callback URL" must be this worker's
 * /callback address.
 */

const PROVIDER = "github";

function page(script) {
  return new Response(
    '<!doctype html><meta charset="utf-8"><title>Signing in</title>' +
      '<body style="font:16px system-ui,sans-serif;padding:2rem;color:#14264F">' +
      "Signing you in&hellip;<script>" +
      script +
      "</script>",
    { headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

/**
 * Hands the result back to the editor window that opened this popup.
 * Decap listens for a message of the form
 *   authorization:github:success:{"token":"...","provider":"github"}
 */
function handshake(ok, data) {
  const message =
    "authorization:" + PROVIDER + ":" + (ok ? "success" : "error") + ":" + JSON.stringify(data);
  return page(
    "(function(){" +
      "function send(e){" +
      "window.opener.postMessage(" + JSON.stringify(message) + ", e.origin);" +
      'window.removeEventListener("message", send, false);' +
      "window.close();" +
      "}" +
      'window.addEventListener("message", send, false);' +
      'window.opener.postMessage("authorizing:' + PROVIDER + '", "*");' +
      "})();"
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
      return new Response(
        "Not configured yet. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET:\n" +
          "  npx wrangler secret put GITHUB_CLIENT_ID\n" +
          "  npx wrangler secret put GITHUB_CLIENT_SECRET\n",
        { status: 500, headers: { "content-type": "text/plain" } }
      );
    }

    // --- start: send the user to GitHub to approve --------------------------
    if (url.pathname === "/auth" || url.pathname === "/") {
      const to = new URL("https://github.com/login/oauth/authorize");
      to.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
      to.searchParams.set("redirect_uri", url.origin + "/callback");
      to.searchParams.set("scope", "repo,user");
      to.searchParams.set("state", crypto.randomUUID());
      return Response.redirect(to.toString(), 302);
    }

    // --- finish: swap the code GitHub gave us for a token -------------------
    if (url.pathname === "/callback") {
      const code = url.searchParams.get("code");
      if (!code) return handshake(false, { error: "GitHub did not return a code" });

      let body;
      try {
        const res = await fetch("https://github.com/login/oauth/access_token", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({
            client_id: env.GITHUB_CLIENT_ID,
            client_secret: env.GITHUB_CLIENT_SECRET,
            code: code,
            redirect_uri: url.origin + "/callback",
          }),
        });
        body = await res.json();
      } catch (err) {
        return handshake(false, { error: "Could not reach GitHub: " + err.message });
      }

      if (!body.access_token) {
        return handshake(false, {
          error: body.error_description || body.error || "GitHub returned no token",
        });
      }
      return handshake(true, { token: body.access_token, provider: PROVIDER });
    }

    return new Response("Client sites editor sign-in service.", {
      status: 404,
      headers: { "content-type": "text/plain" },
    });
  },
};
