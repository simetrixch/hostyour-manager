import type { Stage } from "./enums.ts";

/** A machine serves the environments of its own stage and no other: a TEST environment never stands on
 *  a PROD machine, nor PROD on a TEST one. */
export const clusterServesStage = (clusterStage: string, stage: Stage): boolean => clusterStage === stage;
