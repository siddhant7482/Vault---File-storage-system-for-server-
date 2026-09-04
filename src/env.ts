/* Loads .env.local before anything that reads process.env.
 * Must be the FIRST import in any CLI entrypoint: ES imports are
 * evaluated in declaration order, so a bare config() call further down
 * the file runs *after* the db module has already been constructed. */
import { config } from "dotenv";

config({ path: ".env.local" });
config();
