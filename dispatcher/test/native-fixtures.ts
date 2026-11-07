import type { NativeEvents, NativeTransport } from "../src/native-transport.ts";

export function scriptedTransport(handler: (input: string, events: NativeEvents) => void): NativeTransport & {
  calls: { argv: readonly string[]; cwd: string; env: NodeJS.ProcessEnv; input: string[] }[];
} {
  const calls: { argv: readonly string[]; cwd: string; env: NodeJS.ProcessEnv; input: string[] }[] = [];
  return {
    calls,
    start(argv, options, events) {
      const call = { argv, ...options, input: [] as string[] };
      calls.push(call);
      queueMicrotask(() => events.spawned());
      return {
        write(input) {
          call.input.push(input);
          queueMicrotask(() => handler(input, events));
          return true;
        },
        endInput() {
          queueMicrotask(() => events.closed({ code: 0, signal: null, error: null }));
        },
      };
    },
  };
}

export const CLI_RESULT = [
  { type: "thread.started", thread_id: "thread-fixture" },
  { type: "turn.started" },
  { type: "item.completed", item: { id: "message-fixture", type: "agent_message", text: "Ready." } },
  { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
].map((value) => JSON.stringify(value)).join("\n") + "\n";
