# conch relay

This Worker is an intentionally stupid rendezvous transport. One Durable
Object is selected by a public, random room ID. It holds at most one Mac
WebSocket and one phone WebSocket and forwards each opaque frame unchanged.
It does not parse conch requests, possess pairing secrets, authenticate users,
or store frames. A newer socket for the same role evicts the older one.

All request IDs, methods, paths, headers, bodies, state, responses, and files
are encrypted end to end by the Mac and phone. The endpoint key comes from the
pairing QR and never reaches Cloudflare.

## Threat boundary

Treat the Worker, Durable Object, Cloudflare, and network as hostile. They can:

- see the public room ID, declared endpoint roles, client IP/network metadata,
  connection times and durations, direction, ciphertext sizes, counts, cadence,
  reconnect patterns, and — because frames are not padded — near-exact payload
  and file totals inferred from ciphertext sizes;
- drop, delay, reorder, duplicate, replay, or truncate frames;
- evict either role or keep both endpoints disconnected indefinitely.

They cannot decrypt or forge accepted content, substitute one route for
another, make an old session frame authenticate after reconnect, make a
duplicate mutation execute twice during a live daemon process, or make
reordered/truncated file chunks appear complete. Availability against the relay
is impossible: knowing only a public room ID is sufficient to evict a role, but
not to authenticate to its peer or claim phone audio.

Exactly-once injection cannot be guaranteed across a Mac daemon crash in the
tiny interval after the target session accepts text but before the daemon can
record an acknowledgement. Conch keeps the phone draft on any ambiguous result
and deduplicates normal reconnect retries in the live daemon.

Transport memory is bounded: request/file/state chunks are 64 KiB, an encrypted
frame is at most 192 KiB, the phone accepts state and ordinary in-memory
responses up to 2 MiB, and downloads stream to a temporary file. Encrypted
per-chunk acknowledgements permit at most one bulk chunk to be outstanding, so
an interactive response can follow no more than 64 KiB of file data. The live Mac
keeps at most 4,096 completed mutation IDs without TTL or eviction; once full it
rejects a new mutation before invoking the handler, so the phone retains its
draft rather than risking duplicate execution.

## Validate locally

```sh
cd relay
bun install
bun test
bun run typecheck
```

## Deploy (Tyler runs this)

No deployment or Cloudflare login is performed by the repository build. When
ready:

```sh
cd relay
bun install
bunx wrangler login
bunx wrangler deploy
```

Copy the resulting Worker URL, then configure the Mac and mint/print the LAN
code plus the relay QR:

```sh
conch set phone-relay-url https://conch-relay.<account>.workers.dev
conch pair
```

The phone stores either that relay pairing or a legacy LAN pairing. It never
silently falls back from one transport to the other.
