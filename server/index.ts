import { config, validateConfig } from "./config.js";
import { connect } from "./models.js";
import { createApp } from "./app.js";
validateConfig();
await connect();
const server = createApp().listen(
  config.port,
  process.env.HOST || "127.0.0.1",
  () => console.info(`API http://127.0.0.1:${config.port}`),
);
process.on("SIGTERM", () => server.close(() => process.exit(0)));
