import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { MongoClient } from "mongodb";
await mkdir(".local/mongodb", { recursive: true });
const child = spawn(
  process.env.MONGOD_BINARY || "mongod",
  [
    "--dbpath",
    ".local/mongodb",
    "--port",
    "27018",
    "--bind_ip",
    "127.0.0.1",
    "--replSet",
    "rs0",
    "--logpath",
    ".local/mongodb.log",
  ],
  { stdio: "inherit" },
);
child.on("error", (e) => {
  console.error("Install MongoDB 8 first:", e.message);
  process.exit(1);
});
let initialized = false;
for (let attempt = 0; attempt < 40; attempt++) {
  const client = new MongoClient(
    "mongodb://127.0.0.1:27018/?directConnection=true",
    { serverSelectionTimeoutMS: 1000 },
  );
  try {
    await client.connect();
    try {
      await client.db("admin").command({ replSetGetStatus: 1 });
    } catch {
      await client
        .db("admin")
        .command({
          replSetInitiate: {
            _id: "rs0",
            members: [{ _id: 0, host: "127.0.0.1:27018" }],
          },
        });
    }
    initialized = true;
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 500));
  } finally {
    await client.close();
  }
}
if (!initialized) {
  child.kill();
  throw new Error("MongoDB failed to initialize");
}
console.info("MongoDB replica set ready on 127.0.0.1:27018");
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
child.on("exit", (code) => process.exit(code || 0));
