import assert from "node:assert/strict";
import {
	extractCommandName,
	extractCommandNames,
	splitCommands,
} from "../../shared/cli-command-parser.js";
import { extractCommandNames as extractServerCommandNames } from "../../server/tool-icons/cli-icon-resolver.js";
import { extractCommandNames as extractWebCommandNames } from "../../web/src/shared/lib/tool-icons.js";

assert.equal(extractServerCommandNames, extractCommandNames);
assert.equal(extractWebCommandNames, extractCommandNames);
assert.deepEqual(splitCommands("git status && npm test | docker ps; echo done"), [
	"git status",
	"npm test",
	"docker ps",
	"echo done",
]);
assert.deepEqual(splitCommands("bash -lc 'git status && npm test'"), [
	"bash -lc 'git status && npm test'",
]);
assert.equal(extractCommandName("NODE_ENV=prod sudo docker ps"), "docker");
assert.equal(extractCommandName("bash -lc 'git push'"), "git");
assert.deepEqual(extractCommandNames("time npm test || /usr/bin/git status"), ["npm", "git"]);

console.log("cli command parser tests passed");
