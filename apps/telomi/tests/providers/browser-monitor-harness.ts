/** Isolated UI/real-Chrome diagnostic. Run with node --import tsx; no LLM or Goal data. */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import express from "express";
import { createServer as createViteServer } from "vite";
import { WebSocketServer } from "ws";
import { BrowserSessionRegistry } from "../../server/providers/browser/session-registry.js";
import { attachBrowserObservationServer, createBrowserObservationRouter } from "../../server/providers/browser/observation-server.js";

const root = mkdtempSync("/tmp/tbm-");
const cleanup: Array<() => void | Promise<void>> = [() => rmSync(root, { recursive: true, force: true })];
let closing: Promise<void> | undefined;
function close(): Promise<void> {
	return closing ??= (async () => {
		for (const release of cleanup.reverse()) {
			try { await release(); } catch (error) { console.error(error); process.exitCode = 1; }
		}
	})();
}
process.on("SIGTERM", () => void close().then(() => process.exit()));
process.on("SIGINT", () => void close().then(() => process.exit()));

try {
const app = express();
const server = createServer(app);
cleanup.push(() => { server.closeAllConnections(); server.close(); });
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Missing address");
const base = `http://127.0.0.1:${address.port}`;
const chrome = spawn(process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
	"--headless=new", "--remote-debugging-port=0", `--user-data-dir=${root}/c`,
	"--no-first-run", "--no-default-browser-check", "about:blank",
], { stdio: "ignore" });
let launchError: Error | undefined;
const chromeExited = new Promise<void>((done) => {
	chrome.once("exit", () => done());
	chrome.once("error", (error) => { launchError = error; done(); });
});
cleanup.push(async () => {
	if (chrome.pid && chrome.exitCode === null && chrome.signalCode === null) chrome.kill("SIGTERM");
	await chromeExited;
});
let cdpPort = "";
for (let attempt = 0; attempt < 100; attempt++) {
	if (launchError) throw launchError;
	if (chrome.exitCode !== null || chrome.signalCode !== null) throw new Error("Chrome exited before becoming ready");
	try { cdpPort = readFileSync(join(root, "c", "DevToolsActivePort"), "utf8").split("\n")[0]!; break; } catch {}
	await new Promise((resolve) => setTimeout(resolve, 100));
}
if (!cdpPort) throw new Error("Chrome failed to start");
const registry = new BrowserSessionRegistry({ namespace: "n", daemonHome: `${root}/d`, cdpUrl: cdpPort, agentBrowserBin: resolve("node_modules/.bin/agent-browser") });
cleanup.push(() => registry.shutdownAll());
const brokenStream = new WebSocketServer({ port: 0, host: "127.0.0.1" });
cleanup.push(() => {
	for (const client of brokenStream.clients) client.terminate();
	brokenStream.close();
});
await new Promise<void>((resolve) => brokenStream.once("listening", resolve));
brokenStream.on("connection", (socket) => {
	socket.send(JSON.stringify({ type: "status", connected: true, screencasting: true }));
	socket.send(JSON.stringify({ type: "frame", seq: 1, data: "invalid-image" }));
});
let corrupt = false;
const streamPort = registry.streamPort.bind(registry);
registry.streamPort = (goal, session) => corrupt ? (brokenStream.address() as { port: number }).port : streamPort(goal, session);
app.use(createBrowserObservationRouter(registry, (id) => id === "browser-test"));
let observation = attachBrowserObservationServer(server, registry, (id) => id === "browser-test");
cleanup.push(() => observation.close());
app.get("/page/:color", (req, res) => {
	const color = req.params.color === "blue" ? "blue" : "red";
	res.type("html").send(`<body style="background:${color};color:white;font:40px sans-serif"><title>${color}</title><h1>${color}</h1><p>Live browser test</p></body>`);
});
app.post("/test/:action", async (req, res) => {
	try {
		if (req.params.action === "disconnect") observation.close();
		else if (req.params.action === "reconnect" || req.params.action === "corrupt") {
			corrupt = req.params.action === "corrupt";
			observation.close();
			observation = attachBrowserObservationServer(server, registry, (id) => id === "browser-test");
		}
		else {
			registry.beginRun("browser-test", "test-run");
			const result = await registry.execute("browser-test", ["open", `${base}/page/${req.params.action}`]);
			if (result.exitCode !== 0) throw new Error(`Browser exit ${result.exitCode}`);
		}
		res.json({ ok: true });
	} catch (error) { res.status(500).json({ error: String(error) }); }
});
const vite = await createViteServer({
	server: { middlewareMode: true, proxy: {}, hmr: false },
	define: { "import.meta.env.VITE_API_BASE": JSON.stringify(base) },
	appType: "custom",
});
cleanup.push(() => vite.close());
app.get("/", async (_req, res) => res.type("html").send(await vite.transformIndexHtml("/", `
<html><head><title>Browser monitor regression</title></head><body><div id="root"></div><button id="checks">Run regression checks</button><pre id="result"></pre>
<script type="module">
import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserHub } from '/src/features/goals/BrowserMonitor.tsx';
import '/src/theme.css';
const h = React.createElement;
createRoot(document.getElementById('root')).render(h('main', {style:{padding:32}},
 h('h1',null,'Browser monitor regression'),
 h('p',null,'Open Agent Browser, then red / blue. Disconnect must hide stale live state.'),
 h('div',{style:{display:'flex',gap:12}},...['red','blue','disconnect','reconnect','corrupt'].map(action=>h('button',{key:action,onClick:()=>fetch('/test/'+action,{method:'POST'})},action))),
 h('div',{style:{position:'absolute',right:40,top:40}},h(BrowserHub,{goals:[{id:'browser-test',title:'Browser regression'}]}))));
const waitFor = async (predicate,label) => {
 const deadline = Date.now()+10000;
 while (!predicate()) {
  if (Date.now()>deadline) throw new Error(label);
  await new Promise(resolve=>setTimeout(resolve,50));
 }
};
const command = async action => { const r=await fetch('/test/'+action,{method:'POST'}); if(!r.ok) throw new Error(await r.text()); };
const canvas = () => document.querySelector('.browser-monitor-viewport canvas');
const rendered = () => canvas() && !canvas().classList.contains('is-waiting');
const color = channel => {
 if (!rendered()) return false;
 const c=canvas(), p=c.getContext('2d').getImageData(10,c.height-10,1,1).data;
 return p[channel]>200 && p[channel===0?2:0]<30;
};
document.getElementById('checks').onclick = async () => {
 const out=document.getElementById('result'); out.textContent='Running';
 try {
  const trigger=document.querySelector('[data-testid="topbar-browser"]');
  if(trigger.getAttribute('aria-expanded')==='true') trigger.click();
  await command('red'); await command('corrupt'); trigger.click();
  await waitFor(rendered,'FAIL: corrupt first stream frame suppresses valid seed screenshot');
  await waitFor(()=>document.querySelector('[role="status"]')?.textContent.includes('解码失败'),'FAIL: decode failure is invisible');
  await command('reconnect'); await waitFor(()=>color(0)&&!document.querySelector('[role="status"]'),'FAIL: reconnect does not render red stream');
  await command('blue'); await waitFor(()=>color(2),'FAIL: navigation does not update live pixels');
  await command('disconnect'); await waitFor(()=>!rendered()&&document.querySelector('[role="status"]')?.textContent.includes('重连'),'FAIL: disconnected stream still presents stale pixels as live');
  await command('reconnect'); await waitFor(()=>color(2),'FAIL: reconnect does not restore current page');
  trigger.click(); await waitFor(()=>!canvas(),'FAIL: monitor does not unmount');
  trigger.click(); await waitFor(()=>color(2),'FAIL: reopening monitor loses current page');
  out.textContent='PASS: corrupt first frame, seed recovery, live navigation, disconnect, reconnect, reopen';
 } catch(error) { out.textContent=String(error); }
};
</script></body></html>`)));
app.use(vite.middlewares);
console.log(`Browser monitor harness: ${base}`);
} catch (error) {
	console.error(error);
	process.exitCode = 1;
	await close();
}
