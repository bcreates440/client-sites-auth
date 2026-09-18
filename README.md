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

No per-client setup needed here — GitHub itself decides whether the signed-in
user can actually save to `<owner>/<client-repo>`, via that repo's own
collaborator list.

## Deploy

```
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
- A client's editor still won't save even with a good login → that's GitHub
  collaborator permissions on their repo, not this worker.
