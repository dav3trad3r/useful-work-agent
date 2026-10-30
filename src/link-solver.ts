import type { Solver } from "./client.js";
import { checkAddress } from "./link-check.js";

// Link-check jobs are done in code, never by a language model: each address is visited (public
// addresses only) and what came back is reported as-is. The checks run side by side.

export const linkSolver: Solver = async (offer) => {
  if (offer.job.kind !== "linkcheck") throw new Error("linkSolver only does link-check jobs");
  const links = await Promise.all(offer.job.items.map(async (item) => ({ item: item.item, ...(await checkAddress(item)) })));
  return { jobId: offer.job.id, answers: [], links };
};
