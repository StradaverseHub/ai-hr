/**
 * Array types for pooled postgres.js clients, fetched once per process instead of once per connection.
 *
 * postgres.js normally runs a pg_type query as the first statement of every new connection. Behind
 * PgBouncer that query needs a server connection like any other, so a burst of new connections queues
 * hundreds of catalogue reads in front of real work (deploy/pgbouncer/README.md, "Connection storms").
 *
 * A pooled client sets fetch_types false and opens its sockets through connectedSocket(). Before any
 * socket opens, one primer connection with postgres.js's ordinary type fetch loads the array parsers and
 * serializers, which are then copied into the client's options. No query on a pooled connection can run
 * before its client has the same array handling an unpooled client has. Direct clients never use this.
 *
 * Plain JavaScript so that the load check (scripts/performance/pgbouncer-load-check.mjs) uses this code.
 */
import net from 'node:net';
import postgres from 'postgres';

/** One loaded type table per pooled URL in this process. A failed load is forgotten and retried. */
const loaded = new Map();

function loadArrayTypes(url) {
  let pending = loaded.get(url);
  if (!pending) {
    pending = (async () => {
      const primer = postgres(url, {max: 1, onnotice: () => {}});
      try {
        // The first query of a connection is postgres.js's own array type fetch; this waits for it.
        await primer`select 1`;
        const {parsers, serializers, shared} = primer.options;
        const arrays = Object.entries(shared.typeArrayMap).map(([element, array]) => [Number(element), array]);
        if (arrays.length === 0) throw new Error('No array types were loaded for the pooled connection.');
        return {
          typeArrayMap: {...shared.typeArrayMap},
          parsers: Object.fromEntries(arrays.map(([, array]) => [array, parsers[array]])),
          serializers: Object.fromEntries(arrays.map(([, array]) => [array, serializers[array]])),
        };
      } finally {
        await primer.end({timeout: 5});
      }
    })();
    loaded.set(url, pending);
    pending.catch(() => { if (loaded.get(url) === pending) loaded.delete(url); });
  }
  return pending;
}

/**
 * Copies the loaded array handling into one client's options with postgres.js's own rule (addArrayType):
 * a type whose array already has both a parser and a serializer, such as those drizzle installs for
 * numeric and date arrays, is left alone; otherwise all three entries are set.
 */
function install(options, types) {
  if (options.shared.pooledTypesInstalled) return;
  for (const [element, array] of Object.entries(types.typeArrayMap)) {
    if (options.parsers[array] && options.serializers[array]) continue;
    options.shared.typeArrayMap[element] = array;
    options.parsers[array] = types.parsers[array];
    options.serializers[array] = types.serializers[array];
  }
  options.shared.pooledTypesInstalled = true;
}

/**
 * postgres.js `socket` hook. It must never reject: postgres.js leaves a connection whose socket hook
 * failed in its connecting state. So a failed type load falls back to postgres.js's own per-connection
 * fetch for this client (its failure path is handled by patches/postgres@3.4.9.patch), and the socket is
 * returned unconnected so that connect errors and connect_timeout take postgres.js's ordinary paths.
 * postgres.js negotiates TLS on it itself.
 */
function connectedSocket(url) {
  return async options => {
    try {
      install(options, await loadArrayTypes(url));
      options.fetch_types = false;
    } catch {
      options.fetch_types = true;
    }
    return net.connect({host: options.host[0], port: options.port[0]});
  };
}

/** Options for a postgres.js client that reaches the database through the pooler. */
export function pooledClientOptions(url) {
  return {fetch_types: false, socket: connectedSocket(url)};
}

/** Tests only: forget the loaded tables. */
export function forgetPooledArrayTypes() {
  loaded.clear();
}
