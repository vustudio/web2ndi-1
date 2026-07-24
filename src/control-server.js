'use strict';
// HTTP control panel + REST API. Serves the single-page UI and exposes the
// endpoints it (and any automation) uses. All channel logic lives in the manager;
// this module is only routing, request parsing, and responses.
//
//   GET  /                      the control panel
//   GET  /status                full JSON snapshot (system + every channel)
//   GET  /preview.jpg?id=chN    latest frame of one channel as JPEG
//   POST /channels              add a channel        (body: channel fields)
//   POST /channels/:id          patch config + restart (body: channel fields)
//   POST /channels/:id/url      swap the page live   (body: { url })
//   POST /channels/:id/reload   reload the page
//   POST /channels/:id/input    OS-level click/keypress (body: { type,key,x,y })
//   POST /channels/:id/click    click a page element by label (body: { label })
//   POST /channels/:id/delete   remove the channel
const http = require('http');
const fs = require('fs');
const path = require('path');

function readJsonBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { resolve({}); } });
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// deps: { app, manager, glMode, machineName, port }
function start(deps) {
  const { app, manager, glMode, machineName, port } = deps;
  const htmlPath = path.join(__dirname, 'control.html');

  const server = http.createServer(async (req, res) => {
    const [pathname, qs] = req.url.split('?');
    const parts = pathname.split('/').filter(Boolean); // e.g. ['channels','ch2','url']
    const query = new URLSearchParams(qs || '');

    try {
      // ---- static + reads --------------------------------------------------
      if (req.method === 'GET' && pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(fs.readFileSync(htmlPath));
        return;
      }
      if (req.method === 'GET' && pathname === '/preview.jpg') {
        const inst = manager.get(query.get('id'));
        if (inst && inst.latestJpeg) {
          res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
          res.end(inst.latestJpeg);
        } else {
          res.writeHead(503);
          res.end();
        }
        return;
      }
      if (req.method === 'GET' && pathname === '/status') {
        let appMetrics = [];
        try { appMetrics = app.getAppMetrics(); } catch (e) { /* not ready */ }
        json(res, 200, manager.status(appMetrics, glMode, machineName));
        return;
      }

      // ---- add -------------------------------------------------------------
      if (req.method === 'POST' && pathname === '/channels') {
        json(res, 200, manager.add(await readJsonBody(req)));
        return;
      }

      // ---- per-channel actions: /channels/:id[/action] ---------------------
      if (req.method === 'POST' && parts[0] === 'channels' && parts[1]) {
        const id = parts[1];
        const action = parts[2];
        if (!manager.has(id)) { res.writeHead(404); res.end('no channel'); return; }

        if (action === 'delete') { manager.remove(id); res.writeHead(200); res.end('ok'); return; }
        if (action === 'reload') { const i = manager.get(id); if (i) i.reload(); res.writeHead(200); res.end('ok'); return; }
        if (action === 'url') { manager.patch(id, { url: (await readJsonBody(req)).url }); res.writeHead(200); res.end('ok'); return; }

        if (action === 'input') {
          const inst = manager.get(id);
          if (!inst) { res.writeHead(404); res.end('no window'); return; }
          try { inst.injectInput(await readJsonBody(req)); }
          catch (e) { res.writeHead(e.message === 'no window' ? 404 : 500); res.end(e.message); return; }
          res.writeHead(200); res.end('ok');
          return;
        }
        if (action === 'click') {
          const inst = manager.get(id);
          const clicked = inst ? await inst.clickLabel((await readJsonBody(req)).label) : false;
          json(res, 200, { clicked: !!clicked });
          return;
        }

        // default: a config patch (may trigger a restart)
        manager.patch(id, await readJsonBody(req));
        res.writeHead(200); res.end('ok');
        return;
      }

      res.writeHead(404);
      res.end('not found');
    } catch (e) {
      res.writeHead(500);
      res.end(String(e));
    }
  });

  server.listen(port, () => console.log(`[webcg] control panel on :${port}`));
  return server;
}

module.exports = { start };
