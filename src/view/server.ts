/**
 * A read-only window onto a run in progress.
 *
 * `node:http`, no dependencies. The rules it holds to are the whole
 * design, and each is one line that would be easy to lose in a refactor:
 *
 *   - binds 127.0.0.1 explicitly, never 0.0.0.0;
 *   - answers GET and nothing else;
 *   - serves fixed workspace routes and ID-scoped retained output downloads;
 *   - has no route that writes, applies, starts or approves anything.
 *
 * The last one is not a limitation to be lifted later. A console that can
 * act is a console that can act by accident, and this design rests on
 * nothing reaching a repository that was not proved and decided.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface ServerRoutes {
  /** The full page. Regenerated per request so it is never stale. */
  readonly page: () => Promise<string>;
  /** Everything that changes while a run is in flight. */
  readonly status: () => Promise<unknown>;
  readonly workspace?: () => Promise<string>;
  readonly output?: (id:string) => Promise<{name:string;bytes:Buffer}>;
}

export const LOOPBACK = "127.0.0.1";

export function createViewServer(routes: ServerRoutes): Server {
  return createServer((request, response) => {
    const send = (code: number, type: string, body: string|Buffer, headers:Record<string,string>={}): void => {
      response.writeHead(code, {
        ...headers,
        "content-type": type,
        "cache-control": "no-store",
        // Nothing here is meant to be embedded anywhere, and the page
        // carries file contents from a project a model has been writing in.
        "x-content-type-options": "nosniff",
        // connect-src is required, and its absence is not a small
        // omission: default-src 'none' governs it, so the page loaded, the
        // polling script ran, and every request was blocked by this very
        // header. The banner then hid itself, which looked exactly like a
        // run that was not happening.
        "content-security-policy":
          "default-src 'none'; img-src data:; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
      });
      response.end(body);
    };

    if (request.method !== "GET") {
      send(405, "text/plain; charset=utf-8", "This server answers GET only. It has no route that writes.\n");
      return;
    }
    // Compared without the query string, and never used as a path.
    const route = (request.url ?? "/").split("?")[0];
    if(route==='/workspace'&&routes.workspace){routes.workspace().then(html=>send(200,'text/html; charset=utf-8',html)).catch(()=>send(500,'text/plain','Workspace unavailable. Existing details are retained.'));return;}
    const output=route?.match(/^\/output\/(artifact-[a-f0-9-]{36})$/u);
    if(output&&routes.output){routes.output(output[1]!).then(file=>send(200,'application/octet-stream',file.bytes,{'content-disposition':`attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`})).catch(()=>send(409,'text/plain','Output unavailable or its retained bytes changed. Inspect it before exporting.'));return;}
    if (route === "/status") {
      routes.status()
        .then((value) => { send(200, "application/json; charset=utf-8", JSON.stringify(value)); })
        .catch((error: unknown) => {
          send(500, "application/json; charset=utf-8", JSON.stringify({ error: String(error) }));
        });
      return;
    }
    if (route === "/" || route === "/index.html") {
      routes.page()
        .then((html) => { send(200, "text/html; charset=utf-8", html); })
        .catch((error: unknown) => {
          send(500, "text/plain; charset=utf-8", `Could not render the page: ${String(error)}\n`);
        });
      return;
    }
    send(404, "text/plain; charset=utf-8", "Not found. No matching read-only view route.\n");
  });
}

/** Loopback only, and a taken port is an error rather than a quiet reassignment. */
export function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      reject(error.code === "EADDRINUSE"
        // Silently choosing another port is how an operator ends up reading
        // yesterday's process and believing it.
        ? new Error(`port ${String(port)} is already in use`)
        : error);
    });
    server.listen(port, LOOPBACK, () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}
