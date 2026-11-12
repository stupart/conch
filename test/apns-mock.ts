import { createServer, type Http2Server, type IncomingHttpHeaders, type ServerHttp2Stream } from "node:http2";

// Apple's push service, played by a local cleartext HTTP/2 server (apns.test.ts, notify-user.test.ts): nothing a test
// sends reaches Apple.

/** A local HTTP/2 server in Apple's place: it records each request and answers as `answer` says. */
export async function mockApns(answer: (headers: IncomingHttpHeaders, body: string) => { status: number; body?: unknown; delayMs?: number }) {
  const seen: Array<{ headers: IncomingHttpHeaders; body: string }> = [];
  const server: Http2Server = createServer();
  server.on("stream", (stream: ServerHttp2Stream, headers) => {
    let body = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => { body += chunk; });
    stream.on("end", () => {
      seen.push({ headers, body });
      const reply = answer(headers, body);
      const respond = () => {
        // A client that gave up first (a timeout test) has taken the stream with it: a late answer goes nowhere.
        if (stream.destroyed || stream.closed) return;
        stream.respond({ ":status": reply.status, "apns-id": "11111111-2222-3333-4444-555555555555", "content-type": "application/json" });
        stream.end(reply.body === undefined ? "" : JSON.stringify(reply.body));
      };
      if (reply.delayMs) setTimeout(respond, reply.delayMs).unref?.();
      else respond();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { origin: `http://127.0.0.1:${port}`, seen, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
