# Browser monitor regression

Run `npm run browser:monitor:harness` from `apps/telomi`. Open its printed
loopback URL in a real browser and click **Run regression checks**.
The page reports PASS or the failed assertion. Stop the harness with Ctrl-C.

This loads the production BrowserHub component and observation proxy, uses
a separate real headless Chrome with a temporary profile and daemon namespace,
and serves local red/blue pages. It does not create Goals or call an LLM.

Checks:

- A corrupt first stream frame does not suppress the valid screenshot seed.
- Decode errors are visible, and disappear when a healthy stream resumes.
- Actual canvas pixels change after navigation, not just the URL label.
- A disconnected stream hides stale pixels and identifies reconnection.
- Reconnection and reopening the panel restore the current page.

Only the corrupt-frame case substitutes an upstream WebSocket. The seed
screenshot still comes from the real browser; normal navigation/recovery use
the native agent-browser daemon. Individual buttons support manual inspection.

The UI follows the separate connection/browser/screencast status handling in
[agent-browser 0.34 Dashboard](https://github.com/vercel-labs/agent-browser/blob/v0.34.0/packages/dashboard/src/store/stream.ts).
We retain the native stream and ACK protocol rather than embed Dashboard's
session management and command execution UI.
