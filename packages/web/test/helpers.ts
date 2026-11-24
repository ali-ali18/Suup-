import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import type { Resolver } from "@suup/sandbox";

export const PUBLIC_IP = "93.184.216.34";

/** A resolver that answers from a table; an unknown name does not resolve. */
export function tableResolver(table: Record<string, string[]>): Resolver & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async resolve(host) {
      calls.push(host);
      const found = table[host];
      if (found === undefined) throw new Error("ENOTFOUND");
      return found;
    },
  };
}

export type Handler = (req: IncomingMessage, res: ServerResponse) => void;

/** A local HTTP server, and a `dial` that sends every connection to it whatever address was validated. */
export async function localSite(handler: Handler): Promise<{
  server: Server;
  port: number;
  requests: { url: string; headers: IncomingMessage["headers"] }[];
  dial(address: string, port: number): Socket;
  close(): Promise<void>;
}> {
  const requests: { url: string; headers: IncomingMessage["headers"] }[] = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url ?? "", headers: req.headers });
    handler(req, res);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    server,
    port,
    requests,
    dial: () => connect({ host: "127.0.0.1", port }),
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

export const ARTICLE_HTML = `<!doctype html>
<html lang="en"><head>
<title>Fixture article | Example Site</title>
<meta property="article:published_time" content="2026-05-01T10:00:00Z">
<style>.x { color: red }</style>
<script>window.stolen = document.cookie; document.title = "hacked";</script>
</head><body>
<nav><a href="/home">Home</a> <a href="/about">About</a></nav>
<article>
<h1>Fixture article</h1>
<p class="byline">By Ada Lovelace</p>
<p>The first paragraph of the article explains the idea in enough words that a reader can tell it is the main text of the page and not a menu or a footer of links.</p>
<p>The second paragraph has a <a href="/docs/more">relative link</a>, a <a href="javascript:alert(1)">script link</a> and an image <img src="/a.png" alt="a diagram of the system">.</p>
<h2>Details</h2>
<ul><li>First point about the thing, with detail.</li><li>Second point about the thing, with detail.</li></ul>
<p>The closing paragraph repeats the main idea once more so the body has plenty of readable text for the extractor to keep together as one article.</p>
<script>alert("inline")</script>
</article>
<footer>Copyright footer text that is not the article</footer>
</body></html>`;
