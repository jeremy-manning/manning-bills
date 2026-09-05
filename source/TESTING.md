# Tests

```bash
cd source && node run_tests.js
```

No `npm install`. No dependencies. Any node will do.

| File | Covers |
|---|---|
| `test_access.js` | Who can see the ledger, and what the page does before anyone proves who they are |
| `test_saving.js` | The version guard, the stale-tab path, and the realtime handler |
| `test_build.js` | What actually ships in `dist_static/` |
| `test_harness.js` | Shared stubs — loads `app_persist_static.js` in a `vm` sandbox |

## Why the old suite is gone

The handoff came with twelve tests. Ten of them (`test.js`–`test10.js`) drove
`index.html` — the **Claude-hosted artifact build**, which this repo does not
produce and does not deploy. They asserted things like
`window.claude.artifact.publish` was called. There is no artifact platform in
this deployment, and no `index.html` at that path to load, so they could not run
at all.

The other two (`test_static1.js`, `test_static2.js`) did target the real build,
but were written against the model that has since been replaced: they asserted
the shared password hash round-tripped correctly, that saves went through
`upsert()`, and that the supabase-js CDN `<script>` tag appeared verbatim. All
three of those are now deliberately false.

Every one of the twelve also required `jsdom`, so running them meant an
`npm install` — which is why, in practice, they had never been run here at all.

What replaced them tests the current contract and needs nothing installed, so
it runs in CI on every push.

## What is deliberately not covered

`app_render.js` and `app_events.js` are not exercised — they are DOM-heavy and
would need a real browser or jsdom. The ledger arithmetic they perform is
unchanged from the handoff and was working in production, so the risk there is
low; the risk was always in access control and in what the build shipped, which
is where the coverage now is.
