import {
  pgProxyQuery
} from "./chunk-VYHCO57O.mjs";

// src/drizzle.ts
import { drizzle as pgProxyDrizzle } from "drizzle-orm/pg-proxy";
function drizzle(connectionStringOrConfig, drizzleConfig) {
  return pgProxyDrizzle(pgProxyQuery(connectionStringOrConfig), drizzleConfig);
}
var drizzle_default = drizzle;
export {
  drizzle_default as default,
  drizzle
};
