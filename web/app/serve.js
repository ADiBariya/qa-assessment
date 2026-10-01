// zero-dependency static server for the harness (Playwright webServer)
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };
http.createServer((req, res) => {
  const p = path.join(__dirname, req.url.split('?')[0] === '/' ? 'index.html' : req.url.split('?')[0]);
  fs.readFile(p, (e, d) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'text/plain' }); res.end(d); });
}).listen(process.env.PORT || 4173, () => console.log('harness on :' + (process.env.PORT || 4173)));
