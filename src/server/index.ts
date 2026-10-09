// Local server: a JSON API over the engine, plus the gate UI in /public.
//   npm start   then open http://localhost:4317

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import type { Actor, Brief, GateDecision } from '../core/types';
import { Engine, GateError, NotFoundError } from '../core/engine';
import { systemClock } from '../core/clock';
import { PUBLIC_DIR } from '../core/paths';
import { STAGES } from '../core/workflow';
import { createLocalConnectors } from '../connectors';
import { MockModel } from '../ai/mock-model';
import { slotValues } from '../ai/slots';
import { sampleBrief } from '../cli/fixtures';

const PORT = Number(process.env.PORT ?? 4317);
// Local only by default. Roles are chosen in the browser and are not authentication:
// put real sign-in in front of this server before you expose it (see docs/extending.md).
const HOST = process.env.HOST ?? '127.0.0.1';

class BadRequestError extends Error {}

function needActor(body: { actor?: Actor }): Actor {
  if (!body?.actor?.name || !body.actor.role) throw new BadRequestError('Request body needs actor.name and actor.role');
  return body.actor;
}
const connectors = createLocalConnectors(systemClock);
const engine = await Engine.create({ connectors, model: new MockModel(), clock: systemClock });

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return (text ? JSON.parse(text) : {}) as T;
  } catch {
    throw new BadRequestError('Request body is not valid JSON');
  }
}

async function serveStatic(path: string, res: ServerResponse): Promise<void> {
  const file = resolve(PUBLIC_DIR, '.' + (path === '/' ? '/index.html' : path));
  if (!file.startsWith(PUBLIC_DIR + sep)) return send(res, 404, { error: 'Not found' });
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    send(res, 404, { error: 'Not found' });
  }
}

type Handler = (params: string[], req: IncomingMessage) => Promise<unknown>;

const routes: [method: string, pattern: RegExp, handler: Handler][] = [
  ['GET', /^\/api\/meta$/, async () => ({
    config: engine.config,
    stages: STAGES,
    channels: await connectors.channels.all(),
    drill: { contentStoreDown: connectors.contentStore.isDown() },
  })],
  ['GET', /^\/api\/sample-brief$/, async () => sampleBrief(systemClock)],
  ['GET', /^\/api\/jobs$/, async () =>
    (await engine.list()).map((j) => ({
      id: j.id,
      title: j.brief.title,
      status: j.status,
      createdAt: j.createdAt,
      waiting: STAGES.filter((s) => j.stages[s.id].status === 'waiting').map((s) => s.label),
    }))],
  ['POST', /^\/api\/jobs$/, async (_, req) => {
    const body = await readBody<{ brief?: Brief; actor?: Actor }>(req);
    if (!body.brief || typeof body.brief !== 'object') throw new BadRequestError('Request body needs a brief');
    return engine.submit(body.brief, needActor(body));
  }],
  ['GET', /^\/api\/jobs\/([\w-]+)$/, async ([id]) => {
    const job = await engine.get(id!);
    if (!job) throw new NotFoundError(`No request with id ${id}`);
    return job;
  }],
  // What the native editor sees at G3: the locked master brief and the facts. Not the primary-locale drafts.
  ['GET', /^\/api\/jobs\/([\w-]+)\/master$/, async ([id]) => {
    const job = await engine.get(id!);
    if (!job) throw new NotFoundError(`No request with id ${id}`);
    if (!job.context) throw new GateError('No facts yet');
    return { brief: job.brief, master: job.master, facts: slotValues(job.context), approvedClaims: job.context.brand.approvedClaims, channels: job.context.channels };
  }],
  ['GET', /^\/api\/jobs\/([\w-]+)\/audit$/, async ([id]) => engine.audit(id!)],
  ['POST', /^\/api\/jobs\/([\w-]+)\/decisions$/, async ([id], req) => engine.decide(id!, await readBody<GateDecision>(req))],
  ['POST', /^\/api\/jobs\/([\w-]+)\/retry-deferred$/, async ([id], req) => engine.retryDeferred(id!, needActor(await readBody<{ actor?: Actor }>(req)))],
  ['POST', /^\/api\/jobs\/([\w-]+)\/revert$/, async ([id], req) => {
    const b = await readBody<{ actor?: Actor; channel: string; locale: string; reason: string }>(req);
    return engine.revert(id!, b.channel, b.locale, needActor(b), b.reason ?? '');
  }],
  // Failure drill: switch the local content store off and on.
  ['POST', /^\/api\/drill\/content-store$/, async (_, req) => {
    const { down } = await readBody<{ down: boolean }>(req);
    connectors.contentStore.setOutage(Boolean(down));
    return { contentStoreDown: connectors.contentStore.isDown() };
  }],
];

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const route = routes.find(([method, pattern]) => method === req.method && pattern.test(url.pathname));
  if (!route) {
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res);
    return send(res, 404, { error: 'Not found' });
  }
  try {
    const params = route[1].exec(url.pathname)!.slice(1);
    send(res, 200, await route[2](params, req));
  } catch (error) {
    if (error instanceof BadRequestError) return send(res, 400, { error: error.message });
    if (error instanceof NotFoundError) return send(res, 404, { error: error.message });
    if (error instanceof GateError) return send(res, 422, { error: error.message, details: error.details });
    console.error(error);
    send(res, 500, { error: (error as Error).message });
  }
}).listen(PORT, HOST, () => {
  console.log(`Content automation engine: http://localhost:${PORT}`);
});
