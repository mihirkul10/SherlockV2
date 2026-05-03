import pino from "pino";

export function createLogger(module: string) {
  return pino({
    transport: {
      target: "pino-pretty",
      options: { colorize: true, translateTime: "HH:MM:ss.l" },
    },
  }).child({ module });
}
