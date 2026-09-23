# client-sites-auth

The GitHub sign-in handshake for every client site's Decap CMS editor
(`/admin/`), shared across all of them. One deployment, one GitHub OAuth
App. Not a website — see `src/index.js` for what it actually does and why.

Point a client site's `admin/config.yml` at it:

```yaml
backend:
  name: github
  repo: <owner>/<client-repo>
  branch: main
  base_url: https://client-sites-auth.<account>.workers.dev
  auth_endpoint: auth
```

GitHub itself decides whether the signed-in user can actually save to
`<owner>/<client-repo>`, via that repo's own collaborator list. The one
per-client step here: **add the site's https origin to `ALLOWED_ORIGINS` in
`src/index.js` and redeploy** — the worker only hands a token to pages on that
list (otherwise any website could open `/auth` and collect an editor's token).

## Deploy

```
node test.mjs          # must print ok
npx wrangler deploy
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
```

The client ID/secret come from a GitHub OAuth App whose **Authorization
callback URL** is set to this worker's `/callback` address, exactly. Regenerate
a lost secret from the OAuth App's page, then re-run the `wrangler secret put`
command above.

**Token expiry** — the OAuth App must have "Expire user access tokens"
**unchecked**. This worker only implements the first token exchange, not
GitHub's refresh flow; checking that box makes editor logins start silently
failing after 8 hours.

## If it breaks

- Confirm it's deployed: `npx wrangler deployments list`
- Confirm both secrets are set: `npx wrangler secret list`
- Confirm the OAuth App's callback URL still exactly matches `.../callback`
- Popup says "Signing you in…" and never closes → the site's origin isn't in
  `ALLOWED_ORIGINS` (check http vs https and `www.`)
- A client's editor still won't save even with a good login → that's GitHub
  collaborator permissions on their repo, not this worker.
