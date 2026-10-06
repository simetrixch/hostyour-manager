// The run page's way back: the card of the unit a run acts on.
import type { RunUnitCardView } from "../../shared/api-types.ts";
import { req } from "./api.ts";

/** The card of the unit a run acts on, or null where the run acts on no consumer or tenant stage. */
export const getRunUnitCard = (runId: string): Promise<RunUnitCardView | null> => req<RunUnitCardView | null>(`/api/runs/${runId}/unit-card`);
