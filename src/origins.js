// The only pages allowed to receive a sign-in. Shared by the GitHub sign-in
// (src/index.js) and the email sign-in (email/index.js). Add a client's https
// origin here when their site goes live, then redeploy BOTH workers.
export const ALLOWED_ORIGINS = [
  "https://bcreates440.github.io", // every *.github.io/<repo>/ site
  "https://wwcashow.com",
  "https://www.wwcashow.com",
  // Sites hosted on Cloudflare (everything except WWCA, which stays on
  // GitHub Pages on purpose - see ops/design/hosting-decision.md).
  "https://jones-uncommon-site.bcreates440.workers.dev",
  "https://montaire-rally-demo.bcreates440.workers.dev",
];
