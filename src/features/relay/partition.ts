/** One community and viewer's durable partition, persisted as `origin:viewer`
 * by the outbox, read state, view state and preference stores. Changing these
 * bytes orphans saved data that leaving a community can no longer purge. */
export function relayPartition(origin: string, viewer: string) {
  return `${origin}:${viewer}`;
}

/** The inverse of `relayPartition`. Origins may contain `:`; viewers never do. */
export function splitPartition(partition: string) {
  const at = partition.lastIndexOf(":");
  return at < 0
    ? undefined
    : {
        communityOrigin: partition.slice(0, at),
        viewer: partition.slice(at + 1),
      };
}

type PartitionedTransport = Readonly<{
  scope?: string | undefined;
  relayAuthor: string;
  viewer: string;
}>;

/** Supported transports set `scope` to the normalized community origin; the
 * relay author only partitions transports that omit it. */
export function transportOrigin(transport: PartitionedTransport) {
  return transport.scope ?? transport.relayAuthor;
}

export function transportPartition(transport: PartitionedTransport) {
  return relayPartition(transportOrigin(transport), transport.viewer);
}
