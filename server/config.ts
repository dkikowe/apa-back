import "dotenv/config";
export const config = {
  port: Number(process.env.PORT || 3001),
  production: process.env.NODE_ENV === "production",
  mongo:
    process.env.MONGODB_URI ||
    "mongodb://127.0.0.1:27018/amanat?replicaSet=rs0",
  origin: process.env.APP_ORIGIN || "http://localhost:5173",
  secret: process.env.SESSION_SECRET || "",
  bucket: process.env.S3_BUCKET || "amanat-private",
};
export function validateConfig() {
  if (config.secret.length < 32)
    throw new Error("SESSION_SECRET must contain at least 32 characters");
  if (config.production && !config.origin.startsWith("https://"))
    throw new Error("Production requires HTTPS APP_ORIGIN");
}
