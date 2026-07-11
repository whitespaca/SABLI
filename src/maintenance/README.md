# Maintenance Architecture

The v1.5 compaction path is shared by manual and automatic maintenance. `SabliDatabase` serializes WAL-visible mutations, flush publication, manifest commits, compaction, and close through one FIFO async mutex. Searches do not take that mutex: they acquire an immutable segment-generation lease, capture the current segment array, and continue against that complete old or new generation.

Flush writes and validates a new metadata-v3 L0 segment, commits the next monotonic manifest generation, publishes the new segment array, clears the memory segment, and rotates the checkpointed WAL generation. Automatic compaction selects immutable segments only; it does not flush memory, change the checkpoint, or rotate the WAL. Manual compaction first flushes memory and then rewrites every active immutable segment.

Both compaction modes read only visible raw documents from their selected inputs. This removes deleted and superseded physical versions while rebuilding all ordinary postings, scoped `elemMatch` postings, Bloom data, offsets, and required current-format files through `SegmentWriter`. The output is opened and fully validated before a manifest can reference it.

The commit boundary is the atomic `CURRENT` replacement. Before it, selected inputs remain authoritative and a failed output is removed. After it, the output manifest is authoritative. The complete replacement reader array is then published, while input readers and directories are retired separately. Physical removal waits until no active search generation references each obsolete reader, including references retained across multiple intermediate generations. Cleanup failures are recorded and retried without rolling back the committed manifest.

The automatic scheduler runs one bounded policy evaluation at a time, uses an unref'ed timer, contains background rejection paths, and records read-only diagnostics. `waitForMaintenance()` drains currently eligible plans deterministically. `close()` cancels scheduled checks, joins an active job, serializes the final flush, waits for search leases, retries safe cleanup, closes active readers, and releases the database lock.
