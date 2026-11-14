import { MemoryWorld } from "./memory-forge.ts";
import { runContract } from "./contract.ts";

runContract("memory reference", () => new MemoryWorld());
