import "dotenv/config";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { connect, Admin } from "../server/models.js";
const username = process.env.ADMIN_USERNAME;
const password = process.env.ADMIN_PASSWORD;
if (!username || !password || password.length < 12)
  throw new Error(
    "Set ADMIN_USERNAME and ADMIN_PASSWORD (minimum 12 characters) in the environment.",
  );
await connect();
const existing = await Admin.findOne();
if (existing && process.env.RESET_ADMIN_PASSWORD !== "true")
  throw new Error(
    "An admin already exists. To reset, set RESET_ADMIN_PASSWORD=true explicitly.",
  );
const passwordHash = await bcrypt.hash(password, 12);
if (existing) {
  existing.username = username;
  existing.passwordHash = passwordHash;
  await existing.save();
  await mongoose.connection.collection("sessions").deleteMany({});
} else await Admin.create({ username, passwordHash });
console.info("Administrator saved. Password is not logged.");
await mongoose.disconnect();
