import assert from "node:assert/strict";

import { isSourceAssetUri, sourceAssetHttpUrl } from "../../web/src/shared/markdown/source-asset.js";

const uri = "source-asset:source:example/assets/figure.png";
const expected = "/api/goals/goal-example/wiki/source-asset?source=source%3Aexample&amp;path=assets%2Ffigure.png";
assert.equal(sourceAssetHttpUrl(uri, "goal-example")?.replaceAll("&", "&amp;"), expected);
assert.equal(isSourceAssetUri(uri), true);
assert.equal(sourceAssetHttpUrl("source-asset:source:example/../secret.png", "goal-example"), null);

console.log("Source Asset Markdown rendering passed");
