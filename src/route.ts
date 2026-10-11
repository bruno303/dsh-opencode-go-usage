/**
 * The authenticated HTTP handler behind both quota routes.
 *
 * This module is the test seam for the host half: {@link createUsageHandler}
 * takes its cache, provider loader, and request admission as arguments, so a
 * test drives the whole request lifecycle with fakes and never starts the DSH
 * runtime or touches the network. Only `node:http` TYPES are imported; the
 * runtime needs nothing beyond the `Buffer` global.
 *
 * Response contract:
 * - `GET  USAGE_ROUTE`   — serve the cache (fresh reading, else load).
 * - `POST REFRESH_ROUTE` — force a reload when the refresh floor allows it,
 *                          otherwise answer with the current reading.
 * - any other method     — `405` with an `Allow` header naming the supported one.
 *
 * Every response is JSON with an explicit `Content-Length`; quota data is
 * `no-store` (it is per-operator and must not be cached by a proxy). Bodies
 * carry only safe facts: never the credential, never the raw upstream body.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PeerAdmission } from '@deepseek-ai/dsh-client-connection'
import type { CachedEnvelope, SnapshotCache } from './cache.js'
import type { UsageEnvelope } from './wire-types.js'

/**
 * Exact route paths. Deliberately NOT under `/api`, which the connection bridge
 * owns; the webserver throws on a duplicate (kind, path), so a collision is a
 * loud load failure instead of a silent hijack.
 */
export const USAGE_ROUTE = '/__dsh_opencode_go_usage__/usage'
/** The refresh route (POST). */
export const REFRESH_ROUTE = '/__dsh_opencode_go_usage__/refresh'

/** Everything the handler needs; every field is injectable for tests. */
export interface UsageHandlerDeps {
  /** TTL cache shared by both routes. */
  cache: SnapshotCache
  /** Provider load (credential resolve + fetch); the cache applies stale rules. */
  loadEnvelope: () => Promise<UsageEnvelope>
  /** Browser-trust admission; a refusal must never reach the provider or cache. */
  admit: (req: IncomingMessage) => PeerAdmission
  /** Clock used only to report the served snapshot's age. @default Date.now */
  now?: () => number
}

/** Header value for the widget's "updated N ago" affordance. */
const AGE_HEADER = 'X-Usage-Snapshot-Age-Ms'

/** Pathname of a node request URL, without query or hash. */
function pathnameOf(url: string | undefined): string {
  const raw = url ?? ''
  const cut = raw.search(/[?#]/)
  return cut === -1 ? raw : raw.slice(0, cut)
}

/**
 * Write one JSON response with an explicit length.
 * @param res - the response to own.
 * @param status - HTTP status code.
 * @param body - JSON-serialisable payload (never carries a secret).
 * @param headers - extra response headers (`Allow`, the age header, …).
 */
function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers?: Readonly<Record<string, string>>,
): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(payload, 'utf8')),
    'Cache-Control': 'no-store',
    ...headers,
  })
  res.end(payload)
}

/** The age header for a snapshot-bearing response, when `fetchedAt` parses. */
function ageHeader(envelope: CachedEnvelope, now: () => number): Record<string, string> {
  const fetchedAt = Date.parse(envelope.snapshot.fetchedAt)
  if (!Number.isFinite(fetchedAt)) return {}
  return { [AGE_HEADER]: String(Math.max(0, now() - fetchedAt)) }
}

/**
 * Build the handler for both quota routes.
 * @param deps - cache, provider loader, admission, optional clock.
 * @returns the `(req, res)` handler registered for {@link USAGE_ROUTE} and {@link REFRESH_ROUTE}.
 */
export function createUsageHandler(deps: UsageHandlerDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const now = deps.now ?? Date.now

  async function serve(res: ServerResponse, force: boolean): Promise<void> {
    if (!force && deps.cache.isFresh()) {
      const cached = deps.cache.get()
      if (cached !== undefined) {
        sendJson(res, 200, cached, ageHeader(cached, now))
        return
      }
    }

    if (force && !deps.cache.canForceRefresh()) {
      const cached = deps.cache.get()
      if (cached !== undefined) {
        sendJson(res, 200, cached, ageHeader(cached, now))
        return
      }
      // Nothing successful has ever loaded and the floor forbids a provider
      // call. Report the throttle rather than silently doing nothing.
      sendJson(res, 200, {
        ok: false,
        reason: 'http',
        message: 'refresh is throttled; no reading is available yet',
      })
      return
    }

    const envelope = await deps.cache.load(deps.loadEnvelope, force ? { force: true } : undefined)
    if (envelope.ok) {
      sendJson(res, 200, envelope, ageHeader(envelope, now))
      return
    }
    sendJson(res, 200, envelope)
  }

  function methodNotAllowed(res: ServerResponse, allowed: string): void {
    sendJson(
      res,
      405,
      { ok: false, reason: 'http', status: 405, message: 'method not allowed' },
      { Allow: allowed },
    )
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      // Admission first: an unauthenticated request must never reach the
      // provider or the cache, and the refusal is passed through verbatim.
      // Inside the try like everything else, because a throw from `admit` is
      // still an unexpected internal failure — it must become the fixed,
      // secret-free 500 below rather than escape the handler with its message.
      const admitted = deps.admit(req)
      if ('rejection' in admitted) {
        const status = admitted.rejection
        sendJson(res, status, { ok: false, reason: 'http', status })
        return
      }

      const method = (req.method ?? 'GET').toUpperCase()
      const path = pathnameOf(req.url)

      if (path === USAGE_ROUTE) {
        if (method !== 'GET') {
          methodNotAllowed(res, 'GET')
          return
        }
        await serve(res, false)
        return
      }

      if (path === REFRESH_ROUTE) {
        if (method !== 'POST') {
          methodNotAllowed(res, 'POST')
          return
        }
        await serve(res, true)
        return
      }

      sendJson(res, 404, { ok: false, reason: 'http', status: 404, message: 'unknown route' })
    } catch {
      // An unexpected throw could carry arbitrary text; answer with a fixed
      // message so no internal detail (let alone a credential) can escape.
      if (res.headersSent !== true) {
        sendJson(res, 500, { ok: false, reason: 'http', status: 500, message: 'internal error' })
      }
    }
  }
}
