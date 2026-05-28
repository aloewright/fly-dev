export default {
  async tail(events: TraceItem[]): Promise<void> {
    for (const event of events) {
      const outcome = event.outcome;
      const scriptName = event.scriptName ?? "unknown";
      const exceptionCount = event.exceptions.length;
      const logCount = event.logs.length;

      if (outcome !== "ok" || exceptionCount > 0) {
        console.error(
          JSON.stringify({
            type: "tail.error",
            script: scriptName,
            outcome,
            exceptions: event.exceptions,
            logs: event.logs,
            eventTimestamp: event.eventTimestamp,
          }),
        );
        continue;
      }

      console.log(
        JSON.stringify({
          type: "tail.ok",
          script: scriptName,
          logCount,
          eventTimestamp: event.eventTimestamp,
        }),
      );
    }
  },
} satisfies ExportedHandler;
