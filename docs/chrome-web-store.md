# Publish to the Chrome Web Store

The store gives your extension its own permanent id. Players' sign-in works once that id is allowed
in your deployment: re-run `npm run setup` and enter it.

1. **Build the store zip.** `npm run setup` writes `.output/aws-city-<version>-chrome.zip`. You can
   also tag a release (`git tag v1.0.0 && git push --tags`; the tag must be `v` + `package.json`'s version), and the
   *release* workflow attaches the zip. By hand: `WXT_STORE_BUILD=true npm run zip` after `npm run setup` (it reads
   the hosted settings from `.env.production` and stops if one is missing).
2. **Developer account.** Register at https://chrome.google.com/webstore/devconsole. It's a one-time
   fee, and you verify your email.
3. **New item.** Upload the zip, then fill in the listing from [store-listing.md](store-listing.md):
   - name, summary, description, category *Education*;
   - screenshots at 1280×800 (`npm run smoke` saves candidates in `.output/smoke/`);
   - a 440×280 promo tile.
4. **Privacy tab:**
   - Single purpose: copy the text from store-listing.md.
   - Permission justifications: copy them from store-listing.md for `tabs`, `activeTab`,
     `identity`, `storage`, `sidePanel` and the `*.console.aws.amazon.com` host.
   - Data usage: tick *Personally identifiable information* (email for sign-in) and *Website
     content* (console labels while the Copilot runs, and screenshots on request). Certify you
     don't sell data.
   - Privacy policy URL: publish [privacy-policy.md](privacy-policy.md), for example with GitHub
     Pages, and paste its URL.
5. **Copy the item id** from the dashboard URL: 32 letters, a–p.
6. **Allow it to sign in.** Run `npm run setup`, enter the store id, and let it redeploy. That adds
   `https://<store-id>.chromiumapp.org/` to Cognito and the id to the server's allowed origins.
   **Edge Add-ons** (Microsoft Partner Center) takes the same zip but gives it an id of its own: enter it at the
   wizard's Edge question, and it's allowed the same way.
7. **Submit for review.** Reviews usually take a few days. Updates: bump `version` in
   `package.json`, tag a release, then upload the new zip.

> Store builds have no manifest `key` (`WXT_STORE_BUILD=true`), because the store assigns its own id.
> Local builds keep the repo's fixed key, so they always get `cnonnlgaamcinogainidheiafkgodmpb`.
