const { createServer } = require("node:http");
const { createReadStream } = require("node:fs");
const { join } = require("node:path");

const routes = {
  "/": ["web/index.html", "text/html"],
  "/app.js": ["web/app.js", "text/javascript"],
  "/deployment.json": ["web/deployment.json", "application/json"],
  "/ethers.js": ["node_modules/ethers/dist/ethers.min.js", "text/javascript"],
  "/DaoVoting.json": ["artifacts/contracts/DaoVoting.sol/DaoVoting.json", "application/json"],
  "/Treasury.json": ["artifacts/contracts/Treasury.sol/Treasury.json", "application/json"],
  "/VoteToken.json": ["artifacts/contracts/VoteToken.sol/VoteToken.json", "application/json"],
};

createServer((req, res) => {
  const route = routes[new URL(req.url, "http://localhost").pathname];
  if (!Array.isArray(route)) return res.writeHead(404).end();
  const [file, type] = route;
  const stream = createReadStream(join(__dirname, "..", file));
  stream.once("open", () => {
    res.writeHead(200, { "Content-Type": type + "; charset=utf-8", "Cache-Control": "no-store" });
    stream.pipe(res);
  });
  stream.once("error", () => res.writeHead(404).end("Run the deployment script first."));
}).listen(4173, "127.0.0.1", () => console.log("http://127.0.0.1:4173"));
