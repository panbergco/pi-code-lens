/**
 * Exit only once what was printed has actually left the process.
 *
 * The CLI must exit explicitly (the graph engine's connection would otherwise
 * keep it alive), and `process.exit()` does not wait for stdout. On a pipe
 * Node's writes are asynchronous, so whatever the reader had not drained yet
 * was discarded: a 262,401-byte answer arrived as 262,144 bytes when the
 * reading program was slow to start, and an independent test cut it at 65,536
 * in 3 of 3 runs. An agent parsing that got an unterminated JSON string.
 *
 * An empty write's callback runs after every earlier write on the same stream
 * has been handed to the OS, so waiting for it is waiting for the output.
 * Bounded, so a reader that never drains cannot hang the command; a reader
 * that closed early (`| head -1`) errors the callback, which also releases it.
 */
export function flushed(stream: NodeJS.WriteStream, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    // A reader that closed early (`| head -1`) makes the stream emit EPIPE,
    // and an unhandled stream error prints a stack trace over output the
    // reader already chose to stop reading. It is not a failure: stop waiting.
    stream.once('error', () => { clearTimeout(timer); resolve(); });
    try {
      stream.write('', () => { clearTimeout(timer); resolve(); });
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

export async function exitAfterFlush(code: number, timeoutMs = 10_000): Promise<never> {
  await Promise.all([flushed(process.stdout, timeoutMs), flushed(process.stderr, timeoutMs)]);
  process.exit(code);
}
